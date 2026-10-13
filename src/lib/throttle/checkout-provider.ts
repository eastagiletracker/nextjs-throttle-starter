import { env } from "@/lib/env"
import type {
  Address,
  Cart,
  CheckoutProvider,
  CheckoutSession,
  WebhookResult,
} from "@/types"
import {
  addCartItems,
  createCart,
  getCart,
  setCartCustomer,
  setCartShippingAddress,
} from "./cart"
import { cancelCheckoutSession, createCartBackedSession } from "./sessions"
import {
  THROTTLE_SIGNATURE_HEADER,
  verifyThrottleSignature,
} from "./webhook"
import type { ThrottleAddress, ThrottleWebhookEvent } from "./types"

function toThrottleAddress(addr?: Address): ThrottleAddress | undefined {
  if (!addr) return undefined
  return {
    firstName: addr.firstName,
    lastName: addr.lastName,
    line1: addr.line1,
    line2: addr.line2,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: addr.country,
    phone: addr.phone,
  }
}

/**
 * CheckoutProvider implementation backed by Throttle.
 *
 * createSession runs the full server-side flow:
 *   1. Resolve a Throttle cart with the buyer's items + shipping address.
 *   2. Create a *cart-backed* checkout session over it.
 *
 * The PaymentEmbed drives that session and, on capture, finalizes a single
 * order carrying the cart's line items, address and totals — no pre-created
 * draft order, no separate bare payment order. The order id isn't known
 * until payment succeeds (it arrives via the embed's `onSucceeded`), so the
 * returned session `id` is the checkout session id, not an order id.
 */
export const throttleCheckoutProvider: CheckoutProvider = {
  async createSession(
    cart: Cart,
    customer?: {
      email: string
      shippingAddress?: Address
      throttleCartId?: string
      throttleCustomerId?: string
      returnUrl?: string
      cancelUrl?: string
    }
  ): Promise<CheckoutSession> {
    if (cart.items.length === 0) {
      throw new Error("Cannot create a checkout session for an empty cart.")
    }

    const shippingAddress = toThrottleAddress(customer?.shippingAddress)
    // Signed-in buyer's Throttle customer. Linking the cart to it is what puts
    // the resulting order in their order history; guests leave it unset.
    const customerId = customer?.throttleCustomerId

    // Reuse the cart the buyer's been adding to all session if the
    // client passed it; only fall back to building from local items
    // when there isn't one yet (first-time flow / cart was cleared).
    let throttleCartId: string
    if (customer?.throttleCartId) {
      // Verify the cart is still in `open` status. A "checked_out"/converted
      // cart can't back a new session.
      const existing = await getCart(customer.throttleCartId).catch(() => null)
      if (existing && existing.status === "open") {
        throttleCartId = existing.id
        // The cart may not carry the final shipping address yet (or the buyer
        // edited it after the shipping quote) — write it so the order does.
        if (shippingAddress) {
          await setCartShippingAddress(throttleCartId, shippingAddress)
        }
        // Usually built before the buyer signed in, so the cart is not linked
        // to their customer yet.
        if (customerId) {
          await setCartCustomer(throttleCartId, customerId)
        }
      } else {
        // Cart went away or already converted; build a fresh one.
        const fresh = await createCart({
          externalId: cart.id,
          customerId,
          customerEmail: customer.email,
          shippingAddress,
        })
        await addCartItems(
          fresh.id,
          cart.items.map((item) => ({
            name: item.variantName
              ? `${item.name} — ${item.variantName}`
              : item.name,
            unitPrice: item.price,
            quantity: item.quantity,
            referenceId: item.variantId,
            imageUrl: item.image.url,
            description: item.image.alt,
            metadata: { productId: item.productId, slug: item.slug },
          }))
        )
        throttleCartId = fresh.id
      }
    } else {
      const throttleCart = await createCart({
        externalId: cart.id,
        customerId,
        customerEmail: customer?.email,
        shippingAddress,
      })
      await addCartItems(
        throttleCart.id,
        cart.items.map((item) => ({
          name: item.variantName
            ? `${item.name} — ${item.variantName}`
            : item.name,
          unitPrice: item.price,
          quantity: item.quantity,
          referenceId: item.variantId,
          imageUrl: item.image.url,
          description: item.image.alt,
          metadata: { productId: item.productId, slug: item.slug },
        }))
      )
      throttleCartId = throttleCart.id
    }

    const session = await createCartBackedSession({
      cartId: throttleCartId,
      customerEmail: customer?.email,
      // Required by Throttle even for the embed flow (no redirect happens).
      // Fall back to the hosted checkout origin when the caller doesn't pass
      // storefront URLs.
      returnUrl:
        customer?.returnUrl ?? env.NEXT_PUBLIC_THROTTLE_CHECKOUT_URL,
      cancelUrl:
        customer?.cancelUrl ?? env.NEXT_PUBLIC_THROTTLE_CHECKOUT_URL,
      // No `allowedMethods` here: it isn't honored by the payment-only
      // PaymentEmbed (Gr4vy iframe), and as of checkout-sdk 1.4 setting it on
      // that path fails loud rather than being silently ignored. Restrict
      // methods via the Gr4vy connector config instead.
    })

    return {
      // The checkout session id — PaymentEmbed resolves its own embed token
      // from it. The order id arrives later via the embed's onSucceeded.
      id: session.checkoutSessionId,
      url:
        session.embedUrl ??
        session.hostedUrl ??
        `${env.NEXT_PUBLIC_THROTTLE_CHECKOUT_URL}/c/${session.checkoutSessionId}`,
      status: "open",
      metadata: { throttleCartId },
    }
  },

  async cancelSession(sessionId: string): Promise<void> {
    await cancelCheckoutSession(sessionId)
  },

  async handleWebhook(
    payload: unknown,
    signature: string
  ): Promise<WebhookResult> {
    if (!env.THROTTLE_WEBHOOK_SECRET) {
      return {
        success: false,
        error:
          "THROTTLE_WEBHOOK_SECRET is not set — cannot verify Throttle webhook signatures.",
      }
    }

    // payload is the *raw* string body from the request — DO NOT JSON.parse
    // it before passing here; the hash is computed over the raw bytes.
    const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload)
    const valid = verifyThrottleSignature({
      rawBody,
      header: signature,
      secret: env.THROTTLE_WEBHOOK_SECRET,
    })
    if (!valid) {
      return { success: false, error: "Invalid Throttle webhook signature." }
    }

    let event: ThrottleWebhookEvent
    try {
      event = JSON.parse(rawBody) as ThrottleWebhookEvent
    } catch {
      return { success: false, error: "Webhook body was not valid JSON." }
    }

    // The data shape varies by event type. Order events carry the order
    // payload; payment events carry { payment, orderId }. Pull the order
    // id off either shape so the caller can fan out from one field.
    const data = event.data as { id?: string; orderId?: string }
    const orderId = data.orderId ?? data.id

    return { success: true, orderId }
  },
}

export { THROTTLE_SIGNATURE_HEADER }
