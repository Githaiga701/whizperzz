/**
 * A stand-in for Safaricom Daraja and Pesapal, used only by the browser tests.
 * It answers the same endpoints the real providers do and calls the site back,
 * so a whole payment can run end to end without touching real money or the internet.
 *
 * Phone numbers ending in 000 simulate a guest cancelling the M-Pesa prompt.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { unipesaSign, verifyUnipesa } from '../../src/lib/payments/gateways/unipesa';
import { nowPaymentsSignature } from '../../src/lib/payments/gateways/nowpayments';
import { E2E_IPOS, E2E_NOWPAYMENTS, E2E_UNIPESA } from './env';

const PORT = Number(process.env['MOCK_PORT'] ?? 4398);
const SMTP_PORT = Number(process.env['MOCK_SMTP_PORT'] ?? 4397);
const PESAPAL_IPN_URL = process.env['MOCK_PESAPAL_IPN_URL'] ?? '';

interface StkRequest {
  CheckoutRequestID: string;
  amount: number;
  phone: string;
  callbackUrl: string;
  resultCode: number | null;
}
interface PesapalOrder {
  trackingId: string;
  merchantRef: string;
  amount: number;
  callbackUrl: string;
  paid: boolean;
  refunded: boolean;
}

interface Mail {
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
}
const mails: Mail[] = [];
const receipts = new Set<string>();

interface HostedPayment {
  id: string;
  ref: string;
  amount: number;
  currency: string;
  returnUrl: string;
  notifyUrl: string;
  status: 'pending' | 'paid' | 'declined' | 'partial';
  extra: Record<string, string>;
}
/** iPOS Pay, Unipesa and NOWPayments payments, by our id. */
const hosted = new Map<string, HostedPayment>();

function page(title: string, body: string) {
  return `<!doctype html><title>${title}</title><h1>${title}</h1>${body}`;
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(303, { Location: to });
  res.end();
}

async function postRaw(url: string, body: string, headers: Record<string, string>): Promise<void> {
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  } catch (e) {
    console.error(`[mock] callback to ${url} failed: ${(e as Error).message}`);
  }
}

function nowPayment(h: HostedPayment) {
  return {
    payment_id: Number(h.extra['paymentId']),
    invoice_id: Number(h.id.replace(/\D/g, '')),
    payment_status: h.status === 'paid' ? 'finished' : h.status === 'partial' ? 'partially_paid' : h.status === 'declined' ? 'expired' : 'waiting',
    pay_address: 'TMockAddress',
    price_amount: h.amount,
    price_currency: 'usd',
    pay_amount: h.amount,
    actually_paid: h.status === 'partial' ? h.amount / 2 : h.status === 'paid' ? h.amount : 0,
    pay_currency: 'usdttrc20',
    order_id: h.ref,
    order_description: 'Whizperz',
    outcome_amount: h.amount,
    outcome_currency: 'usdttrc20',
  };
}

const stk = new Map<string, StkRequest>();
const orders = new Map<string, PesapalOrder>();
let counter = 0;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function post(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.error(`[mock] callback to ${url} failed: ${(e as Error).message}`);
  }
}

function receiptFor(r: StkRequest): string {
  const receipt = `MOCK${r.CheckoutRequestID.slice(-6)}`;
  receipts.add(receipt);
  return receipt;
}

function sendStkCallback(r: StkRequest) {
  const ok = r.resultCode === 0;
  return post(r.callbackUrl, {
    Body: {
      stkCallback: {
        MerchantRequestID: `m-${r.CheckoutRequestID}`,
        CheckoutRequestID: r.CheckoutRequestID,
        ResultCode: r.resultCode,
        ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
        ...(ok
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: r.amount },
                  { Name: 'MpesaReceiptNumber', Value: receiptFor(r) },
                  { Name: 'TransactionDate', Value: 20261023120000 },
                  { Name: 'PhoneNumber', Value: Number(r.phone) },
                ],
              },
            }
          : {}),
      },
    },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    /* ---- Daraja ---- */
    if (path === '/oauth/v1/generate') {
      if (!req.headers.authorization?.startsWith('Basic ')) return send(res, 400, { errorMessage: 'Invalid Authentication passed' });
      return send(res, 200, { access_token: 'mock-daraja-token', expires_in: '3599' });
    }
    if (path === '/mpesa/stkpush/v1/processrequest') {
      const b = await readBody(req);
      if (req.headers.authorization !== 'Bearer mock-daraja-token') return send(res, 401, { errorMessage: 'Invalid Access Token' });
      const id = `ws_CO_MOCK${String(++counter).padStart(6, '0')}`;
      const phone = String(b['PhoneNumber']);
      const r: StkRequest = { CheckoutRequestID: id, amount: Number(b['Amount']), phone, callbackUrl: String(b['CallBackURL']), resultCode: null };
      stk.set(id, r);
      // The guest "answers" the prompt a moment later.
      setTimeout(() => {
        r.resultCode = phone.endsWith('000') ? 1032 : 0;
        void sendStkCallback(r);
      }, 1000);
      return send(res, 200, { MerchantRequestID: `m-${id}`, CheckoutRequestID: id, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success' });
    }
    if (path === '/mpesa/stkpushquery/v1/query') {
      const b = await readBody(req);
      const r = stk.get(String(b['CheckoutRequestID']));
      if (!r) return send(res, 400, { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid CheckoutRequestID' });
      if (r.resultCode === null) return send(res, 500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
      return send(res, 200, {
        ResponseCode: '0',
        ResponseDescription: 'The service request has been accepted successsfully',
        MerchantRequestID: `m-${r.CheckoutRequestID}`,
        CheckoutRequestID: r.CheckoutRequestID,
        ResultCode: String(r.resultCode),
        ResultDesc: r.resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      });
    }

    if (path === '/mpesa/reversal/v1/request') {
      if (req.headers.authorization !== 'Bearer mock-daraja-token') return send(res, 401, { errorMessage: 'Invalid Access Token' });
      const b = await readBody(req);
      if (!b['Initiator'] || !b['SecurityCredential']) return send(res, 400, { errorMessage: 'Bad Request - Invalid Initiator' });
      const conversationId = `AG_MOCK_${++counter}`;
      const originator = `orig-${counter}`;
      const known = receipts.has(String(b['TransactionID']));
      setTimeout(() => {
        void post(String(b['ResultURL']), {
          Result: known
            ? { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: originator, ConversationID: conversationId, TransactionID: `REV${counter}` }
            : { ResultType: 0, ResultCode: 'R000002', ResultDesc: 'The OriginalTransactionID is invalid.', OriginatorConversationID: originator, ConversationID: conversationId, TransactionID: '' },
        });
      }, 800);
      return send(res, 200, { OriginatorConversationID: originator, ConversationID: conversationId, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
    }

    /* ---- Pesapal ---- */
    if (path === '/pesapalv3/api/URLSetup/RegisterIPN') {
      const b = await readBody(req);
      return send(res, 200, { url: b['url'], ipn_id: 'mock-ipn-registered', ipn_notification_type_description: 'POST', ipn_status_description: 'Active', error: null, status: '200' });
    }
    if (path === '/pesapalv3/api/Transactions/RefundRequest') {
      const b = await readBody(req);
      const o = [...orders.values()].find((x) => x.paid && `PSP${x.trackingId.slice(-4)}` === b['confirmation_code']);
      if (!o) return send(res, 200, { status: '500', message: 'Invalid confirmation code' });
      if (o.refunded) return send(res, 200, { status: '500', message: 'Only one refund is allowed per payment' });
      if (Number(b['amount']) > o.amount || !b['username'] || !b['remarks']) return send(res, 200, { status: '500', message: 'Refund rejected' });
      o.refunded = true;
      return send(res, 200, { status: '200', message: 'Refund request successfully' });
    }
    if (path === '/pesapalv3/api/Auth/RequestToken') return send(res, 200, { token: 'mock-pesapal-token', expiryDate: new Date(Date.now() + 300_000).toISOString(), error: null, status: '200' });
    if (path === '/pesapalv3/api/Transactions/SubmitOrderRequest') {
      const b = await readBody(req);
      const trackingId = `mock-track-${++counter}`;
      orders.set(trackingId, { trackingId, merchantRef: String(b['id']), amount: Number(b['amount']), callbackUrl: String(b['callback_url']), paid: false, refunded: false });
      return send(res, 200, {
        order_tracking_id: trackingId,
        merchant_reference: b['id'],
        redirect_url: `http://127.0.0.1:${PORT}/checkout?OrderTrackingId=${trackingId}`,
        error: null,
        status: '200',
      });
    }
    if (path === '/pesapalv3/api/Transactions/GetTransactionStatus') {
      const o = orders.get(url.searchParams.get('orderTrackingId') ?? '');
      if (!o) return send(res, 200, { error: { code: 'invalid_tracking_id', message: 'Order not found' }, status: '500' });
      return send(res, 200, {
        payment_method: 'Visa',
        amount: o.amount,
        confirmation_code: o.paid ? `PSP${o.trackingId.slice(-4)}` : '',
        payment_status_description: o.refunded ? 'Reversed' : o.paid ? 'Completed' : 'Pending',
        description: '',
        status_code: o.refunded ? 3 : o.paid ? 1 : 0,
        merchant_reference: o.merchantRef,
        currency: 'KES',
        error: null,
        status: '200',
      });
    }
    /* The fake hosted checkout page the guest is sent to. */
    if (path === '/checkout') {
      const o = orders.get(url.searchParams.get('OrderTrackingId') ?? '');
      if (!o) return send(res, 404, 'Unknown order', 'text/plain');
      return send(
        res,
        200,
        `<!doctype html><title>Mock Pesapal</title><h1>Mock Pesapal checkout</h1><p>KES ${o.amount}</p><form method="post" action="/checkout/pay?OrderTrackingId=${o.trackingId}"><button>Pay now</button></form>`,
        'text/html',
      );
    }
    if (path === '/checkout/pay' && req.method === 'POST') {
      const o = orders.get(url.searchParams.get('OrderTrackingId') ?? '');
      if (!o) return send(res, 404, 'Unknown order', 'text/plain');
      o.paid = true;
      await post(PESAPAL_IPN_URL, { OrderTrackingId: o.trackingId, OrderMerchantReference: o.merchantRef, OrderNotificationType: 'IPNCHANGE' });
      const back = new URL(o.callbackUrl);
      back.searchParams.set('OrderTrackingId', o.trackingId);
      back.searchParams.set('OrderMerchantReference', o.merchantRef);
      back.searchParams.set('OrderNotificationType', 'CALLBACKURL');
      res.writeHead(303, { Location: back.toString() });
      return res.end();
    }

    /* ---- iPOS Pay (iPOSpays) ---- */
    if (path === '/ipos/auth/v1/authenticate-token' && req.method === 'POST') {
      if (req.headers['apikey'] !== E2E_IPOS.apiKey || req.headers['secretkey'] !== E2E_IPOS.secretKey) {
        return send(res, 401, { errors: [{ code: 'AUTH_ERR_004', message: 'Invalid Credentials, Please Contact Support Team.' }] });
      }
      return send(res, 200, { responseCode: '00', responseMessage: 'Success', token: 'mock-ipos-token' });
    }
    if (path === '/ipos/payment/api/v3/external-payment-transaction' && req.method === 'POST') {
      if (req.headers['token'] !== 'mock-ipos-token') return send(res, 401, { message: 'Invalid token' });
      const b = await readBody(req);
      const auth = b['merchantAuthentication'] as Record<string, string>;
      const tr = b['transactionRequest'] as Record<string, string>;
      const n = b['notificationOption'] as Record<string, string>;
      if (auth['merchantId'] !== E2E_IPOS.tpn) return send(res, 400, { errors: [{ field: 'merchantAuthentication.merchantId', message: 'Invalid merchant id' }] });
      const id = `ipos-${++counter}`;
      hosted.set(id, { id, ref: auth['transactionReferenceId']!, amount: Number(tr['amount']), currency: 'USD', returnUrl: n['returnUrl']!, notifyUrl: n['postAPI']!, status: 'pending', extra: { authHeader: n['authHeader'] ?? '' } });
      return send(res, 200, { message: 'Url generated Successful', information: `http://127.0.0.1:${PORT}/ipos/pay?t=${id}` });
    }
    if (path === '/ipos/pay') {
      const h = hosted.get(url.searchParams.get('t') ?? '');
      if (!h) return send(res, 404, 'Unknown payment', 'text/plain');
      return send(res, 200, page('Mock iPOSpays checkout', `<p>USD ${(h.amount / 100).toFixed(2)}</p><form method="post" action="/ipos/pay/done?t=${h.id}&ok=1"><button>Pay now</button></form><form method="post" action="/ipos/pay/done?t=${h.id}&ok=0"><button>Decline</button></form>`), 'text/html');
    }
    if (path === '/ipos/pay/done' && req.method === 'POST') {
      const h = hosted.get(url.searchParams.get('t') ?? '');
      if (!h) return send(res, 404, 'Unknown payment', 'text/plain');
      h.status = url.searchParams.get('ok') === '1' ? 'paid' : 'declined';
      await postRaw(h.notifyUrl, JSON.stringify({ iposHPResponse: { transactionReferenceId: h.ref, responseCode: h.status === 'paid' ? 200 : 400 } }), { Authorization: h.extra['authHeader'] ?? '' });
      return redirect(res, h.returnUrl);
    }
    if (path === '/ipos/api/v1/queryPaymentStatus') {
      if (req.headers.authorization !== 'mock-ipos-token') return send(res, 401, { message: 'Unauthorized' });
      const h = [...hosted.values()].find((x) => x.id.startsWith('ipos-') && x.ref === url.searchParams.get('transactionReferenceId') && url.searchParams.get('tpn') === E2E_IPOS.tpn);
      if (!h) return send(res, 404, { message: 'Transaction not found' });
      return send(res, 200, {
        iposHPResponse: {
          responseCode: h.status === 'paid' ? 200 : h.status === 'declined' ? 400 : 102,
          responseMessage: h.status === 'paid' ? 'Successful' : h.status === 'declined' ? 'Declined' : 'Pending',
          transactionReferenceId: h.ref,
          transactionId: `IPOS${h.id.replace(/\D/g, '')}`,
          transactionType: 1,
          cardType: 'VISA',
          cardLast4Digit: '4242',
          amount: String(h.amount),
          totalAmount: String(h.amount),
        },
      });
    }

    /* ---- Unipesa ---- */
    if (path === '/unipesa/hpp' && req.method === 'GET') {
      const fields = Object.fromEntries(url.searchParams) as Record<string, string>;
      if (fields['merchant_id'] !== E2E_UNIPESA.merchantId || !verifyUnipesa(fields, E2E_UNIPESA.secretKey)) {
        return send(res, 400, page('Unipesa error', '<p>Invalid signature</p>'), 'text/html');
      }
      const id = `uni-${++counter}`;
      hosted.set(id, { id, ref: fields['order_id']!, amount: Number(fields['amount']), currency: fields['currency']!, returnUrl: fields['return_url']!, notifyUrl: fields['callback_url']!, status: 'pending', extra: {} });
      return send(res, 200, page('Mock Unipesa checkout', `<p>${fields['currency']} ${fields['amount']}</p><form method="post" action="/unipesa/hpp/done?t=${id}&ok=1"><button>Pay now</button></form><form method="post" action="/unipesa/hpp/done?t=${id}&ok=0"><button>Cancel</button></form>`), 'text/html');
    }
    if (path === '/unipesa/hpp/done' && req.method === 'POST') {
      const h = hosted.get(url.searchParams.get('t') ?? '');
      if (!h) return send(res, 404, 'Unknown payment', 'text/plain');
      h.status = url.searchParams.get('ok') === '1' ? 'paid' : 'declined';
      const cb: Record<string, unknown> = {
        merchant_id: E2E_UNIPESA.merchantId,
        operation_type: 17,
        customer_id: '254712345678',
        amount: h.amount.toFixed(2),
        order_id: h.ref,
        transaction_id: `T${h.id.replace(/\D/g, '')}`,
        transaction_ref: `UNI${h.id.replace(/\D/g, '')}`,
        status: h.status === 'paid' ? 2 : 4,
        provider_id: 12,
        result: { code: 0, message: 'Success' },
        provider_result: { code: 0, message: h.status === 'paid' ? 'Success' : 'Cancelled by customer' },
      };
      cb['signature'] = unipesaSign(cb, E2E_UNIPESA.secretKey);
      await postRaw(h.notifyUrl, JSON.stringify(cb), {});
      return redirect(res, h.returnUrl);
    }

    /* ---- NOWPayments (crypto) ---- */
    if (path === '/nowpayments/v1/invoice' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== E2E_NOWPAYMENTS.apiKey) return send(res, 403, { status: false, statusCode: 403, code: 'INVALID_API_KEY', message: 'Invalid api key' });
      const b = await readBody(req);
      const id = `np-${++counter}`;
      hosted.set(id, { id, ref: String(b['order_id']), amount: Number(b['price_amount']), currency: String(b['price_currency']).toUpperCase(), returnUrl: String(b['success_url']), notifyUrl: String(b['ipn_callback_url']), status: 'pending', extra: { paymentId: String(5000 + counter) } });
      return send(res, 200, { id: id.replace(/\D/g, ''), order_id: b['order_id'], price_amount: String(b['price_amount']), price_currency: b['price_currency'], invoice_url: `http://127.0.0.1:${PORT}/nowpayments/pay?t=${id}` });
    }
    if (path === '/nowpayments/pay') {
      const h = hosted.get(url.searchParams.get('t') ?? '');
      if (!h) return send(res, 404, 'Unknown invoice', 'text/plain');
      return send(res, 200, page('Mock NOWPayments invoice', `<p>USD ${h.amount}</p><form method="post" action="/nowpayments/pay/done?t=${h.id}&how=full"><button>Send USDT</button></form><form method="post" action="/nowpayments/pay/done?t=${h.id}&how=partial"><button>Send half</button></form>`), 'text/html');
    }
    if (path === '/nowpayments/pay/done' && req.method === 'POST') {
      const h = hosted.get(url.searchParams.get('t') ?? '');
      if (!h) return send(res, 404, 'Unknown invoice', 'text/plain');
      h.status = url.searchParams.get('how') === 'partial' ? 'partial' : 'paid';
      const body = nowPayment(h);
      // Confirmations arrive a moment after the guest is back on the site, like a real blockchain.
      setTimeout(() => void postRaw(h.notifyUrl, JSON.stringify(body), { 'x-nowpayments-sig': nowPaymentsSignature(body, E2E_NOWPAYMENTS.ipnSecret) }), 800);
      return redirect(res, h.returnUrl);
    }
    if (path.startsWith('/nowpayments/v1/payment/')) {
      if (req.headers['x-api-key'] !== E2E_NOWPAYMENTS.apiKey) return send(res, 403, { message: 'Invalid api key' });
      const h = [...hosted.values()].find((x) => x.extra['paymentId'] === path.split('/').pop());
      if (!h) return send(res, 404, { message: 'Payment not found' });
      return send(res, 200, nowPayment(h));
    }
    if (path === '/nowpayments/v1/merchant/coins') {
      if (req.headers['x-api-key'] !== E2E_NOWPAYMENTS.apiKey) return send(res, 403, { message: 'Invalid api key' });
      return send(res, 200, { selectedCurrencies: ['usdttrc20', 'btc', 'eth'] });
    }

    /* ---- Mail the site sent (read by the tests) ---- */
    if (path === '/mails') return send(res, 200, mails);

    if (path === '/health') return send(res, 200, { ok: true });
    return send(res, 404, { error: 'not found', path });
  } catch (err) {
    console.error('[mock]', err);
    return send(res, 500, { error: String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] Daraja + Pesapal mock on http://127.0.0.1:${PORT}`));

/* A mail server that accepts everything and keeps it for the tests to read at /mails. */
const smtp = new SMTPServer({
  authOptional: true,
  hideSTARTTLS: true,
  disabledCommands: ['STARTTLS'],
  logger: false,
  onAuth(_auth, _session, cb) {
    cb(null, { user: 'test' });
  },
  onData(stream, _session, cb) {
    simpleParser(stream)
      .then((m) => {
        const to = Array.isArray(m.to) ? m.to.map((a) => a.text).join(', ') : (m.to?.text ?? '');
        mails.push({ to, subject: m.subject ?? '', text: m.text ?? '', receivedAt: new Date().toISOString() });
        cb();
      })
      .catch((e: Error) => cb(e));
  },
});
smtp.listen(SMTP_PORT, '127.0.0.1', () => console.log(`[mock] SMTP on 127.0.0.1:${SMTP_PORT}`));
