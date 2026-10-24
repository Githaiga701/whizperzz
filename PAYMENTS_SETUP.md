# Whizperz Tours payment integration setup

The site currently has no payment backend, provider accounts, or live checkout. The `.env.example` file records safe environment defaults for the next implementation step; every credential is intentionally blank. Copy it to a private `.env` only in a local backend/deployment environment, and never put credentials in browser JavaScript or commit the private file.

## Default choices

- **M-Pesa:** Daraja sandbox with STK Push (M-Pesa Express). A manual Till number can be added as a separate, non-API option after Whizperz confirms its registered Till and how booking references should be matched.
- **Pesapal:** API 3 sandbox. The production connection needs merchant credentials and a publicly reachable HTTPS IPN endpoint. Pesapal requires the registered IPN ID on order requests, and transaction status must be reconciled server-side.
- **iPOS Pay:** UAT environment. Confirm the exact iPOS product and merchant account first; the public iPOSpays documentation describes both direct transaction and hosted payment page products.
- **Unipesa:** hosted payment page as the planned default, using its test/simulator flow once Unipesa issues merchant access and confirms the right provider IDs for Kenya.
- **Crypto:** no processor selected yet. Keep disabled until Whizperz chooses a processor, supported assets, settlement currency and refund policy.

## Before implementation can accept test payments

1. Create/obtain sandbox access and confirm the correct account product for each provider.
2. Choose a backend host and a public HTTPS domain for return and webhook/IPN callbacks. This workspace is currently static HTML.
3. Set a quote/order source of truth so the browser cannot choose or change the amount paid.
4. Create server-side payment order endpoints, persist order and provider references, and verify callbacks/status with each provider before marking a booking paid.
5. Run provider sandbox flows, then separately configure approved production credentials and callback URLs before launch.

## Documentation references

- [Safaricom Daraja developer portal](https://developer.safaricom.co.ke/apis) and [Daraja FAQs](https://developer.safaricom.co.ke/faqs)
- [Pesapal API 3.0 documentation](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/api-reference) and [IPN registration](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/registeripnurl)
- [iPOSpays developer documentation](https://uatdocs.ipospays.tech/hosted-payment-page/apidocs)
- [Unipesa payment API documentation](https://docs.unipesa.io/)
