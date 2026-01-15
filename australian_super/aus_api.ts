import { ApolloServer } from 'apollo-server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLScalarType, Kind } from 'graphql';
import { requestOtp, verifyOtp, queryWithSession } from './aus_super';

const typeDefs = readFileSync(join(__dirname, '..', 'schema.graphql'), 'utf8');

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

// persistent OTP/session store shared across GraphQL requests
const globalOtpStore = new Map<string, any>();

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
        const identifierArg = args && args.identifier ? args.identifier : null;
        const headers = context && context.headers ? context.headers : {};
        const authHeader = headers.authorization || headers.Authorization || '';
        const identifier = identifierArg || (authHeader || '').toString().replace(/^Bearer\s+/i, '');
        if (!identifier) throw new Error('missing token for Account access; provide Authorization header or pass token argument');

        const details: any = await queryWithSession(identifier);
        if (!details) return null;
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
  }
  ,
  Mutation: {
    auth: async (_: any, { payload }: { payload: any }, context: any) => {
      try {
        if (!context.otpStore) context.otpStore = new Map<string, any>();

        const { id, pin, otp, identifier } = payload || {};

        // First step: request OTP token
        if (id && pin) {
          const { identifier, storageState, response } = await requestOtp(id, pin, false);
          // store both token and storageState so verifyOtp can reuse the original page
          if (identifier) {
            // if requestOtp indicated immediate success, mark verified
            context.otpStore.set(identifier, { token: identifier, storageState, verified: false, otp_required: response === 'need_otp' });
          }
          return { 
            response: response, 
            identifier: identifier 
          };
        }

        // Second step: verify OTP using provided otpToken and code
        if (otp && identifier) {
          const entry = context.otpStore.get(identifier);
          // Only allow verify when requestOtp previously returned 'need_otp'
          if (!entry || entry.verified === true || entry.otp_required === false) {
            return { response: 'invalid_or_unnecessary' };
          }
          // prefer passing the session token back to verifyOtp so it reuses the stored page
          let passValue: any = identifier;
          if (entry && entry.token) {
            passValue = entry.token;
          } else if (entry && entry.storageState) {
            passValue = entry.storageState;
          }
          const res = await verifyOtp(otp, passValue).catch(() => ({ response: 'fail' }));
          // if verification succeeded, mark verified and return success
          if (res && res.response === 'success') {
            try { entry.verified = true; context.otpStore.set(identifier, entry); } catch (_) {}
            return { response: res.response };
          }
          return { response: res.response || 'fail' };
        }

      } catch (err: any) {
        return { response: err && err.message ? err.message : 'error' };
      }
    }
  }
};

async function start() {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // use a persistent otpStore so OTP sessions survive across GraphQL requests
    context: ({ req }) => ({ headers: req ? req.headers : {}, fetchCache: new Map(), otpStore: globalOtpStore })
  });
  const { url } = await server.listen({ port: 4000 });
  console.log(`GraphQL server running at ${url}`);
}

start().catch((err) => {
  console.error('Failed to start GraphQL server:', err);
  process.exit(1);
});