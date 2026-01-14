import { ApolloServer } from 'apollo-server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLScalarType, Kind } from 'graphql';
import { queryWithSession, requestSession } from './cbus';

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

const resolvers = {
  JSON: JSONScalar,
  Query: {
    account: async (_: any, args: any, context: any) => {
      try {

        const storageIdentifier = args && args.identifier ? args.identifier : null;
        if (!storageIdentifier) throw new Error('missing identifier for Account access; provide Authorization header or pass identifier argument');

        const key = typeof storageIdentifier === 'string'
          ? storageIdentifier
          : (storageIdentifier && storageIdentifier.identifier) || null;
        if (!key) throw new Error('missing identifier for Account access; provide Authorization header or pass identifier argument');

        if (!context.fetchCache) context.fetchCache = new Map();
        if (!context.fetchCache.has(key)) {

          context.fetchCache.set(key, (queryWithSession as any)(storageIdentifier));
        }
        const details: any = await context.fetchCache.get(key);
        if (!details) throw new Error('missing identifier for Account access; provide Authorization header or pass identifier argument');
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
        const { username, password } = payload || {};
        
        // create a stored session by providing username/password
        if (username && password) {
          const res = await requestSession(username, password, false);
          return {
            response: res.response,
            identifier: res.identifier
          };
        }
      } catch (err: any) {
        return { response: err && err.message ? err.message : 'error', identifier: null };
      }
    }
  }
};

async function start() {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => ({ headers: req ? req.headers : {}, fetchCache: new Map() })
  });
  const { url } = await server.listen({ port: 4000 });
  console.log(`GraphQL server running at ${url}`);
}

start().catch((err) => {
  console.error('Failed to start GraphQL server:', err);
  process.exit(1);
});