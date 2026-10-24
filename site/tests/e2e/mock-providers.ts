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
