import { ApolloServer } from 'apollo-server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLScalarType, Kind } from 'graphql';
import { requestOtp, verifyOtp, queryWithSession, resendOtp } from './aus_super';

// Concurrency / queueing: allow up to 3 concurrent active sessions; queue FIFO
const MAX_CONCURRENT = 3;
const SLOT_PROFILES = [
  'C:\\pw-chrome-profile_1',
  'C:\\pw-chrome-profile_2',
  'C:\\pw-chrome-profile_3'
];
const activeSlots: boolean[] = new Array(MAX_CONCURRENT).fill(false);
const waitQueue: Array<(slotIndex: number) => void> = [];
const typeDefs = readFileSync(join(__dirname, '..', 'schema.graphql'), 'utf8');

const sessions = new Map<string, { slotHeld: boolean; createdAt: number; slotIndex?: number }>();

const globalOtpStore = new Map<string, any>();

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  parseValue: (value) => value,
  serialize: (value) => value,
  parseLiteral: (ast) => {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT: {
        const value: any = Object.create(null);
        ast.fields.forEach((field: any) => {
          value[field.name.value] = parseLiteral(field.value);
        });
        return value;
      }
      case Kind.LIST:
        return ast.values.map(parseLiteral);
      default:
        return null;
    }
  }
});

function parseLiteral(ast: any): any {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.OBJECT: {
      const value: any = Object.create(null);
      ast.fields.forEach((field: any) => {
        value[field.name.value] = parseLiteral(field.value);
      });
      return value;
    }
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    default:
      return null;
  }
}

function acquireSlot(): Promise<number> {
  const freeIndex = activeSlots.findIndex(v => !v);
  if (freeIndex !== -1) {
    activeSlots[freeIndex] = true;
    const activeCount = activeSlots.filter(Boolean).length;
    console.log(`[slot] acquire -> index=${freeIndex} active=${activeCount}`);
    return Promise.resolve(freeIndex);
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    const activeCount = activeSlots.filter(Boolean).length;
    console.log(`[slot] queued -> active=${activeCount}, queue=${waitQueue.length}`);
  });
}

function releaseSlot(slotIndex?: number) {
  try {
    if (typeof slotIndex === 'number' && slotIndex >= 0 && slotIndex < activeSlots.length) {
      const next = waitQueue.shift();
      if (next) {
        try { next(slotIndex); } catch (e) { /* ignore */ }
        const activeCount = activeSlots.filter(Boolean).length;
        console.log(`[slot] handoff -> index=${slotIndex} active=${activeCount}`);
        return;
      }
      activeSlots[slotIndex] = false;
      const activeCount = activeSlots.filter(Boolean).length;
      console.log(`[slot] release -> index=${slotIndex} active=${activeCount}`);
    } else {
      const idx = activeSlots.findIndex(v => v);
      if (idx === -1) return;
      const next = waitQueue.shift();
      if (next) {
        try { next(idx); } catch (e) { /* ignore */ }
        const activeCount = activeSlots.filter(Boolean).length;
        console.log(`[slot] handoff -> index=${idx} active=${activeCount}`);
        return;
      }
      activeSlots[idx] = false;
      const activeCount = activeSlots.filter(Boolean).length;
      console.log(`[slot] release -> index=${idx} active=${activeCount}`);
    }
  } catch (e) {
    console.error('releaseSlot error:', e);
  }
}

const resolvers = {
  JSON: JSONScalar,
  Transaction: {
    transactionTime: (parent: any) => {
      const val = parent && parent.transactionTime;
      if (!val) return val;
      const d = new Date(val);
      if (isNaN(d.getTime())) return val;
      return d.toISOString();
    }
  },
  Query: {
    account: async (_: any, args: any, context: any) => {
      try {
        const storageIdentifier = args && args.identifier ? args.identifier : null;
        if (!storageIdentifier) throw new Error('Invalid or expired identifier');

        const key = typeof storageIdentifier === 'string'
          ? storageIdentifier
          : (storageIdentifier && storageIdentifier.identifier) || null;
        if (!key) throw new Error('Invalid or expired identifier');

        if (!context.fetchCache) context.fetchCache = new Map();
        if (!context.fetchCache.has(key)) {
          context.fetchCache.set(key, (queryWithSession as any)(storageIdentifier));
        }
        const details: any = await context.fetchCache.get(key);
        if (!details) throw new Error('Invalid or expired identifier');
        return [{
          id: details.id || details.cardNumber || null,
          name: details.name || 'Account',
          balance: details.balance,
          currency: details.currency
        }];
      } catch (err: any) {
        const msg = err && err.message ? err.message : 'Failed to fetch account';
        throw new Error(msg);
      }
    },
    transaction: async (_: any, args: any, context: any) => {
      try {
        const storageIdentifier = args && args.identifier ? args.identifier : null;
        if (!storageIdentifier) throw new Error('Invalid or expired identifier');

        const key = typeof storageIdentifier === 'string'
          ? storageIdentifier
          : (storageIdentifier && storageIdentifier.identifier) || null;
        if (!key) throw new Error('Invalid or expired identifier');

        if (!context.fetchCache) context.fetchCache = new Map();
        if (!context.fetchCache.has(key)) {
          context.fetchCache.set(key, (queryWithSession as any)(storageIdentifier));
        }
        const details: any = await context.fetchCache.get(key);
        if (!details) throw new Error('Invalid or expired identifier');
        const prefix = details.id || details.cardNumber || '';
        return (details.transactions || []).map((t: any, idx: number) => ({
          transactionId: `${prefix}-${idx + 1}`,
          transactionTime: t.transactionTime || t.date,
          amount: t.amount,
          currency: t.currency,
          description: t.description,
          status: 'confirmed',
          balance: t.balance,
        }));
      } catch (err: any) {
        const msg = err && err.message ? err.message : 'Failed to fetch transactions';
        throw new Error(msg);
      }
    }
  },
  Mutation: {
    auth: async (_: any, { payload }: { payload: any }, context: any) => {
      try {
        if (!context.otpStore) context.otpStore = globalOtpStore;

        const { id, pin, otp, identifier, send } = payload || {};
        let assignedSlot: number | null = null;

        // Resend OTP
        if (send === true) {
          if (!identifier) return { response: 'missing_identifier', identifier: null };
          const r = await resendOtp(identifier).catch(() => ({ response: 'fail' }));
          return { response: r.response, identifier: identifier };
        }

        // Step 1: request OTP
        if (id && pin) {
          assignedSlot = await acquireSlot();
          try {
            const userDataDir = SLOT_PROFILES[assignedSlot] || undefined;
            const res = await requestOtp(id, pin, false, userDataDir);
            if (res && res.response && (res.identifier || res.storageState)) {
              const token = res.identifier || res.storageState || null;
              const tokenKey = typeof token === 'string' ? token : (token && token.identifier) || null;
              if (tokenKey) {
                sessions.set(tokenKey, { slotHeld: true, createdAt: Date.now(), slotIndex: assignedSlot });
                if (context && context.otpStore) context.otpStore.set(tokenKey, { storageState: res.storageState, verified: false });
              }
              if (!(res.response)) return { response: 'fail', identifier: null };
              return { response: res.response, identifier: res.identifier};
            }
            releaseSlot(assignedSlot);
            return { response: 'fail', identifier: null };
          } catch (e: any) {
            releaseSlot(assignedSlot);
            return { response: 'fail', identifier: null };
          }
        }

        // Step 2: verify OTP
        if (otp && identifier) {
          const entry = context.otpStore && context.otpStore.get(identifier);
          let passValue: any = identifier;
          if (entry && entry.storageState) passValue = entry.storageState;
          const res = await verifyOtp(otp, passValue).catch(() => ({ response: 'fail' }));
          if (res && res.response === 'success') {
            try { if (context.otpStore) context.otpStore.set(identifier, { ...(entry || {}), verified: true }); } catch (_) {}
            return { response: res.response, identifier };
          }
          return { response: res.response };
        }

        return { response: 'invalid_payload', identifier: null };
      } catch (err: any) {
        const msg = err && err.message ? err.message : 'error';
        return { response: msg, identifier: null };
      }
    }
  }
};

// periodically force-release stale held sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 30_000) {
      console.warn(`[slot] force release expired session ${id}`);
      sessions.delete(id);
      try { if (typeof s.slotIndex === 'number') releaseSlot(s.slotIndex); else releaseSlot(); } catch (_) { releaseSlot(); }
    }
  }
}, 10_000);

async function start() {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // use a persistent otpStore so OTP sessions survive across GraphQL requests
    context: ({ req }) => ({ headers: req ? req.headers : {}, fetchCache: new Map(), otpStore: globalOtpStore }),
    plugins: [
      {
        async requestDidStart(requestContext) {
          const identifierVar = requestContext.request.variables?.identifier;

          return {
            async willSendResponse() {
              const id = typeof identifierVar === 'string'
                ? identifierVar
                : (identifierVar && identifierVar.identifier) ? identifierVar.identifier : null;
              if (!id) return;
              const s = sessions.get(id);
              if (!s || !s.slotHeld) return;
              sessions.delete(id);
              try { if (typeof s.slotIndex === 'number') releaseSlot(s.slotIndex); else releaseSlot(); } catch (_) { releaseSlot(); }
              console.log(`[slot] session=${id} released & cleared`);
            }
          };
        }
      }
    ]
  });
  const { url } = await server.listen({ port: 4000 });
  console.log(`GraphQL server running at ${url}`);
}

start().catch((err) => {
  console.error('Failed to start GraphQL server:', err);
  process.exit(1);
});