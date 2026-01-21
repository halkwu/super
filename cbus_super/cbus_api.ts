import { ApolloServer } from 'apollo-server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLScalarType, Kind } from 'graphql';
import { queryWithSession, requestSession } from './cbus';

// Concurrency / queueing: allow up to 3 concurrent active sessions;
// additional auth requests are queued FIFO until a slot becomes available.
const MAX_CONCURRENT = 3;
let activeCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    console.log(`[slot] acquire -> active=${activeCount}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    console.log(`[slot] queued -> active=${activeCount}, queue=${waitQueue.length}`);
  });
}

function releaseSlot() {
  if (activeCount <= 0) return;
  activeCount--;
  console.log(`[slot] release -> active=${activeCount}`);
  const next = waitQueue.shift();
  if (next) {
    activeCount++;
    console.log(`[slot] handoff -> active=${activeCount}`);
    try { next(); } catch (e) { /* ignore */ }
  }
}

const typeDefs = readFileSync(join(__dirname, '..', 'schema.graphql'), 'utf8');

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  parseValue: (value) => value,
  serialize: (value) => value,
  parseLiteral: (ast: any) => parseLiteral(ast),
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

const resolvers = {
  JSON: JSONScalar,
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
          id: details.id,
          name: details.name,
          balance: details.balance,
          currency: details.currency
        }];
      } catch (err: any) {
        const msg = err && err.message ? err.message : 'Failed to fetch account';
        throw new Error(msg);
      }
    }
  },
  Mutation: {
    auth: async (_: any, { payload }: { payload: any }, context: any) => {
      try {
        const { id, pin } = payload || {};

        if (id && pin) {
          await acquireSlot();
          try {
            const res = await requestSession(id, pin, false);
            if (res && res.response === 'success' && res.identifier) {
              sessions.set(res.identifier, { slotHeld: true, createdAt: Date.now() });
              return { response: res.response, identifier: res.identifier };
            }
            // request failed, release reserved slot
            releaseSlot();
            return { response: 'fail', identifier: null };
          } catch (e: any) {
            releaseSlot();
            return { response: 'fail', identifier: null };
          }
        }
      } catch (err: any) {
          releaseSlot();
          return { response: 'fail', identifier: null };
      }
    }
  }
};

type HeldSession = { slotHeld: boolean; createdAt: number };
const sessions = new Map<string, HeldSession>();

async function start() {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: () => ({}),
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
              releaseSlot();
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

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 30_000) {
      console.warn(`[slot] force release expired session ${id}`);
      sessions.delete(id);
      releaseSlot();
    }
  }
}, 10_000);

start().catch((e) => {
  console.error('Failed to start GraphQL server', e);
  process.exit(1);
});