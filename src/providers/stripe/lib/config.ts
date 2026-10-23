/** Which Stripe environment a secret or restricted key reaches. */
export type StripeMode = "production" | "sandbox";
/** Stripe's main REST origin. The PDF origin is confined separately. */
export const STRIPE_API_BASE_URL = "https://api.stripe.com";
