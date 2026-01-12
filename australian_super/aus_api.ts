import { ApolloServer } from 'apollo-server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLScalarType, Kind } from 'graphql';
import { queryResult } from './aus_super';

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

const DateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'ISO-8601 date string',
  serialize: (value: any) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return null;
  },
  parseValue: (value: any) => {
    return value ? new Date(value) : null;
  },
  parseLiteral: (ast: any) => {
    if (ast.kind === Kind.STRING) return new Date(ast.value);
    return null;
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
  Date: DateScalar,
  JSON: JSONScalar,
  Query: {
    Account: async (_: any, { id, pin, headless }: { id: string, pin: string, headless?: boolean }, context: any) => {
      const useHeadless = typeof headless === 'boolean' ? headless : true;
      const key = `${id}:${pin}:${useHeadless}`;
      try {
        if (!context.fetchCache) context.fetchCache = new Map();
        if (!context.fetchCache.has(key)) {
          context.fetchCache.set(key, (queryResult as any)(id, pin || '', useHeadless));
        }
        const details: any = await context.fetchCache.get(key);
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
};

async function start() {
  const server = new ApolloServer({ typeDefs, resolvers });
  const { url } = await server.listen({ port: 4000 });
  console.log(`GraphQL server running at ${url}`);
}

start().catch((err) => {
  console.error('Failed to start GraphQL server:', err);
  process.exit(1);
});