//! Rajista Pay: a shop's till asks for USDC, and this program makes sure the
//! money can only go where the shop owner said, once, for the agreed amount.
//!
//! A sale becomes a Bill account. The till that rang it up signs it; the
//! program checks that till was registered by the owner and that the USDC
//! amount really is the naira price at the recorded rate. The customer's
//! wallet then pays the bill. The program moves exactly the bill amount, in
//! USDC, into the payout account the owner set, and refuses a second payment,
//! a late payment, a different token, or a different destination.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("4y78XTmZk9GERsxhP4ezpnfuqX2iZh3Dq3aKZYk3XtQq");

/// USDC on mainnet and on devnet. A shop can only be set up to take one of these.
pub const USDC_MINTS: [Pubkey; 2] = [
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
];

/// A bill stays payable for at most 15 minutes, because its rate goes stale.
pub const MAX_TTL_SECS: i64 = 900;

#[program]
pub mod till {
    use super::*;

    pub fn register_shop(ctx: Context<RegisterShop>, shop_id: [u8; 16]) -> Result<()> {
        let shop = &mut ctx.accounts.shop;
        shop.owner = ctx.accounts.owner.key();
        shop.shop_id = shop_id;
        shop.mint = ctx.accounts.mint.key();
        shop.payout = ctx.accounts.payout.key();
        shop.bills_paid = 0;
        shop.total_paid = 0;
        shop.bump = ctx.bumps.shop;
        emit!(ShopRegistered { shop: shop.key(), owner: shop.owner, mint: shop.mint, payout: shop.payout });
        Ok(())
    }

    pub fn set_payout(ctx: Context<SetPayout>) -> Result<()> {
        let shop = &mut ctx.accounts.shop;
        let old = shop.payout;
        shop.payout = ctx.accounts.payout.key();
        emit!(PayoutChanged { shop: shop.key(), old, new: shop.payout });
        Ok(())
    }

    pub fn add_till(ctx: Context<AddTill>, till_key: Pubkey) -> Result<()> {
        let till = &mut ctx.accounts.till;
        till.shop = ctx.accounts.shop.key();
        till.key = till_key;
        till.bump = ctx.bumps.till;
        emit!(TillAdded { shop: till.shop, till: till_key });
        Ok(())
    }

    pub fn remove_till(ctx: Context<RemoveTill>) -> Result<()> {
        emit!(TillRemoved { shop: ctx.accounts.shop.key(), till: ctx.accounts.till.key });
        Ok(())
    }

    pub fn post_bill(
        ctx: Context<PostBill>,
        sale_id: [u8; 16],
        amount: u64,
        naira_kobo: u64,
        rate_kobo: u64,
        ttl_secs: i64,
    ) -> Result<()> {
        // The till must be one the owner registered for this shop. Checked by
        // hand so an unknown or removed till gets a clear error instead of a
        // generic "account not initialised".
        let till_info = ctx.accounts.till.to_account_info();
        require!(
            till_info.owner == &crate::ID && !till_info.data_is_empty(),
            TillError::TillNotRegistered
        );
        let till = Till::try_deserialize(&mut &till_info.data.borrow()[..])?;
        require_keys_eq!(till.shop, ctx.accounts.shop.key(), TillError::TillNotRegistered);
        require_keys_eq!(till.key, ctx.accounts.till_signer.key(), TillError::TillNotRegistered);

        require!(amount > 0 && naira_kobo > 0 && rate_kobo > 0, TillError::ZeroAmount);
        require!(ttl_secs > 0 && ttl_secs <= MAX_TTL_SECS, TillError::BadTtl);
        // The USDC asked for must be the naira price at the stated rate,
        // rounded up to the next micro-USDC, so the record cannot disagree
        // with itself.
        require!(amount == usdc_for(naira_kobo, rate_kobo)?, TillError::AmountMismatch);

        let now = Clock::get()?.unix_timestamp;
        let bill = &mut ctx.accounts.bill;
        bill.shop = ctx.accounts.shop.key();
        bill.till = ctx.accounts.till_signer.key();
        bill.sale_id = sale_id;
        bill.amount = amount;
        bill.naira_kobo = naira_kobo;
        bill.rate_kobo = rate_kobo;
        bill.created_at = now;
        bill.expires_at = now + ttl_secs;
        bill.paid = false;
        bill.payer = Pubkey::default();
        bill.paid_at = 0;
        bill.rent_payer = ctx.accounts.payer.key();
        bill.bump = ctx.bumps.bill;
        emit!(BillPosted {
            shop: bill.shop,
            bill: bill.key(),
            till: bill.till,
            sale_id,
            amount,
            naira_kobo,
            rate_kobo,
            expires_at: bill.expires_at,
        });
        Ok(())
    }

    pub fn pay_bill(ctx: Context<PayBill>) -> Result<()> {
        let bill = &ctx.accounts.bill;
        // Paying twice is the failure a shop fears most, so it is checked first.
        require!(!bill.paid, TillError::BillAlreadyPaid);
        let now = Clock::get()?.unix_timestamp;
        require!(now <= bill.expires_at, TillError::BillExpired);

        let amount = bill.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.payout.to_account_info(),
                    authority: ctx.accounts.customer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let bill = &mut ctx.accounts.bill;
        bill.paid = true;
        bill.payer = ctx.accounts.customer.key();
        bill.paid_at = now;

        let shop = &mut ctx.accounts.shop;
        shop.bills_paid = shop.bills_paid.checked_add(1).ok_or(TillError::Overflow)?;
        shop.total_paid = shop.total_paid.checked_add(amount).ok_or(TillError::Overflow)?;

        emit!(BillPaid {
            shop: shop.key(),
            bill: bill.key(),
            till: bill.till,
            sale_id: bill.sale_id,
            amount,
            naira_kobo: bill.naira_kobo,
            rate_kobo: bill.rate_kobo,
            payer: bill.payer,
            payout: shop.payout,
            paid_at: now,
        });
        Ok(())
    }

    /// Give a finished bill's rent back to whoever paid it. The payment itself
    /// stays in the transaction history as a BillPaid event and in the shop's
    /// running totals, so closing a bill never loses the record.
    pub fn close_bill(ctx: Context<CloseBill>) -> Result<()> {
        let bill = &ctx.accounts.bill;
        let now = Clock::get()?.unix_timestamp;
        require!(bill.paid || now > bill.expires_at, TillError::BillStillOpen);
        Ok(())
    }
}

/// micro-USDC for a naira price at a rate given in kobo per USDC, rounded up.
pub fn usdc_for(naira_kobo: u64, rate_kobo: u64) -> Result<u64> {
    let n = (naira_kobo as u128) * 1_000_000u128;
    let r = rate_kobo as u128;
    let v = (n + r - 1) / r;
    u64::try_from(v).map_err(|_| error!(TillError::Overflow))
}

#[account]
#[derive(InitSpace)]
pub struct Shop {
    pub owner: Pubkey,
    pub shop_id: [u8; 16],
    pub mint: Pubkey,
    pub payout: Pubkey,
    pub bills_paid: u64,
    pub total_paid: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Till {
    pub shop: Pubkey,
    pub key: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bill {
    pub shop: Pubkey,
    pub till: Pubkey,
    pub sale_id: [u8; 16],
    pub amount: u64,
    pub naira_kobo: u64,
    pub rate_kobo: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub paid: bool,
    pub payer: Pubkey,
    pub paid_at: i64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(shop_id: [u8; 16])]
pub struct RegisterShop<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Shop::INIT_SPACE,
        seeds = [b"shop", owner.key().as_ref(), shop_id.as_ref()],
        bump
    )]
    pub shop: Account<'info, Shop>,
    #[account(constraint = USDC_MINTS.contains(&mint.key()) @ TillError::WrongMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = payout.mint == mint.key() @ TillError::WrongMint)]
    pub payout: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPayout<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ TillError::NotOwner)]
    pub shop: Account<'info, Shop>,
    #[account(constraint = payout.mint == shop.mint @ TillError::WrongMint)]
    pub payout: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(till_key: Pubkey)]
pub struct AddTill<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = owner @ TillError::NotOwner)]
    pub shop: Account<'info, Shop>,
    #[account(
        init,
        payer = payer,
        space = 8 + Till::INIT_SPACE,
        seeds = [b"till", shop.key().as_ref(), till_key.as_ref()],
        bump
    )]
    pub till: Account<'info, Till>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveTill<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ TillError::NotOwner)]
    pub shop: Account<'info, Shop>,
    #[account(mut, close = owner, has_one = shop @ TillError::TillNotRegistered)]
    pub till: Account<'info, Till>,
}

#[derive(Accounts)]
#[instruction(sale_id: [u8; 16])]
pub struct PostBill<'info> {
    pub till_signer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub shop: Account<'info, Shop>,
    /// CHECK: the PDA for this shop and this till key; whether it is a live
    /// registration is checked in the handler so the error can say so.
    #[account(seeds = [b"till", shop.key().as_ref(), till_signer.key().as_ref()], bump)]
    pub till: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Bill::INIT_SPACE,
        seeds = [b"bill", shop.key().as_ref(), sale_id.as_ref()],
        bump
    )]
    pub bill: Account<'info, Bill>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayBill<'info> {
    pub customer: Signer<'info>,
    #[account(mut)]
    pub shop: Account<'info, Shop>,
    #[account(mut, has_one = shop @ TillError::WrongShop)]
    pub bill: Account<'info, Bill>,
    #[account(address = shop.mint @ TillError::WrongMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, constraint = from.mint == shop.mint @ TillError::WrongMint)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = shop.payout @ TillError::WrongPayout)]
    pub payout: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseBill<'info> {
    pub closer: Signer<'info>,
    #[account(mut, close = rent_payer, has_one = rent_payer @ TillError::WrongRentPayer)]
    pub bill: Account<'info, Bill>,
    /// CHECK: only receives lamports; must match the address stored on the bill.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

#[event]
pub struct ShopRegistered {
    pub shop: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub payout: Pubkey,
}

#[event]
pub struct PayoutChanged {
    pub shop: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct TillAdded {
    pub shop: Pubkey,
    pub till: Pubkey,
}

#[event]
pub struct TillRemoved {
    pub shop: Pubkey,
    pub till: Pubkey,
}

#[event]
pub struct BillPosted {
    pub shop: Pubkey,
    pub bill: Pubkey,
    pub till: Pubkey,
    pub sale_id: [u8; 16],
    pub amount: u64,
    pub naira_kobo: u64,
    pub rate_kobo: u64,
    pub expires_at: i64,
}

#[event]
pub struct BillPaid {
    pub shop: Pubkey,
    pub bill: Pubkey,
    pub till: Pubkey,
    pub sale_id: [u8; 16],
    pub amount: u64,
    pub naira_kobo: u64,
    pub rate_kobo: u64,
    pub payer: Pubkey,
    pub payout: Pubkey,
    pub paid_at: i64,
}

#[error_code]
pub enum TillError {
    #[msg("This bill has already been paid")]
    BillAlreadyPaid,
    #[msg("Money can only go to the payout account the shop owner set")]
    WrongPayout,
    #[msg("This bill has expired; ring it up again for a fresh rate")]
    BillExpired,
    #[msg("This till is not registered to this shop")]
    TillNotRegistered,
    #[msg("Only USDC is accepted")]
    WrongMint,
    #[msg("Only the shop owner can do this")]
    NotOwner,
    #[msg("This bill belongs to a different shop")]
    WrongShop,
    #[msg("Amounts and rate must be above zero")]
    ZeroAmount,
    #[msg("A bill must expire within 15 minutes")]
    BadTtl,
    #[msg("The USDC amount does not match the naira price at this rate")]
    AmountMismatch,
    #[msg("The bill is still open: unpaid and not yet expired")]
    BillStillOpen,
    #[msg("Rent goes back only to whoever paid it")]
    WrongRentPayer,
    #[msg("Number too large")]
    Overflow,
}
