// This utility requires the 'pg' Node.js package and its types ('@types/pg').
// Ensure they are added to your package.json:
// npm install pg
// npm install --save-dev @types/pg
// or
// yarn add pg
// yarn add --dev @types/pg

import { Pool, QueryResultRow, PoolConfig } from 'pg';

let pool: Pool | undefined;

interface DbConfig extends PoolConfig {
  dbSslRequired?: boolean; // Custom flag to easily toggle SSL from env
}

function getPool(): Pool {
  if (!pool) {
    const {
      RDS_USER,
      RDS_HOST,
      RDS_DB_NAME,
      RDS_PASSWORD,
      RDS_PORT,
      DB_SSL_REQUIRED, // 'true' or 'false'
      // Optional pool settings from env
      DB_POOL_MAX_CLIENTS,
      DB_POOL_IDLE_TIMEOUT_MS,
      DB_POOL_CONNECTION_TIMEOUT_MS,
    } = process.env;

    if (!RDS_USER || !RDS_HOST || !RDS_DB_NAME || !RDS_PASSWORD) {
      console.error('Missing required RDS environment variables (USER, HOST, DB_NAME, PASSWORD)');
      throw new Error('Missing required RDS environment variables.');
    }

    const dbConfig: DbConfig = {
      user: RDS_USER,
      host: RDS_HOST,
      database: RDS_DB_NAME,
      password: RDS_PASSWORD,
      port: RDS_PORT ? parseInt(RDS_PORT, 10) : 5432,
      dbSslRequired: DB_SSL_REQUIRED === 'true',
      // Optional pool configurations
      max: DB_POOL_MAX_CLIENTS ? parseInt(DB_POOL_MAX_CLIENTS, 10) : 10, // e.g., 10-20 clients
      idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS ? parseInt(DB_POOL_IDLE_TIMEOUT_MS, 10) : 30000, // e.g., 30 seconds
      connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS ? parseInt(DB_POOL_CONNECTION_TIMEOUT_MS, 10) : 5000, // e.g., 5 seconds
    };

    if (dbConfig.dbSslRequired) {
      // For RDS, typically ssl mode 'verify-full' or 'verify-ca' is recommended with AWS CA cert.
      // For simplicity here, we'll use a basic configuration.
      // In a production environment, you might need to provide process.env.RDS_CA_CERT
      // and set ssl: { rejectUnauthorized: true, ca: process.env.RDS_CA_CERT }
      dbConfig.ssl = { rejectUnauthorized: false }; // Adjust for production needs
      console.log('Database connection SSL enabled.');
    }

    console.log(`Initializing PostgreSQL connection pool for host: ${dbConfig.host}, db: ${dbConfig.database}`);

    pool = new Pool(dbConfig);

    pool.on('connect', (client) => {
      console.log(`PostgreSQL client connected. Total clients: ${pool?.totalCount}, Idle clients: ${pool?.idleCount}`);
      // You could set client-level settings here if needed, e.g., client.query('SET TIME ZONE "UTC";');
    });

    pool.on('error', (err, client) => {
      console.error('Unexpected error on idle PostgreSQL client', err);
      // process.exit(-1); // Optional: exit if critical, or allow pool to manage
    });

    // Test connection (optional, but good for immediate feedback on startup)
    pool.query('SELECT NOW()')
      .then(res => console.log('PostgreSQL pool successfully initialized and tested at:', res.rows[0].now))
      .catch(err => {
        console.error('Failed to initialize PostgreSQL pool or test connection:', err);
        // Potentially throw error here to prevent function from running with bad DB config
        // For Twilio Functions, throwing here might stop the function deployment/startup if called during global scope init.
      });
  }
  return pool;
}

/**
 * Executes a SQL query against the PostgreSQL database.
 * @param text The SQL query string (can include placeholders like $1, $2).
 * @param params Optional array of parameters to substitute into the query.
 * @returns A promise that resolves to an array of result rows.
 * @template T The expected row type.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const poolInstance = getPool();
  const start = Date.now();

  try {
    const res = await poolInstance.query<T>(text, params);
    const duration = Date.now() - start;
    console.log(
      `Executed query: { text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"` +
      (params && params.length > 0 ? `, params: [${params.map(p => typeof p === 'string' ? `"${p.substring(0,20)}..."` : p).join(', ')}]` : '') +
      `, duration: ${duration}ms, rows: ${res.rowCount} }`
    );
    return res.rows;
  } catch (error) {
    const duration = Date.now() - start;
    // @ts-ignore
    console.error(`Error executing query (duration: ${duration}ms): { text: "${text.substring(0,100)}${text.length > 100 ? '...' : ''}", params: ${params} } Error: ${error.message}`, error);
    // @ts-ignore
    throw new Error(`Database query failed: ${error.message}`); // Re-throw for the calling function to handle
  }
}

/*
// Optional: Function to get a dedicated client for transactions

import { PoolClient } from 'pg';

export async function getClient(): Promise<PoolClient> {
  const poolInstance = getPool();
  const client = await poolInstance.connect();
  return client;
}

// Usage for transactions:
// const client = await getClient();
// try {
//   await client.query('BEGIN');
//   // ... your queries using client.query(...)
//   await client.query('COMMIT');
// } catch (e) {
//   await client.query('ROLLBACK');
//   throw e;
// } finally {
//   client.release();
// }
*/

// Initialize pool on load for faster first execution in some serverless environments,
// but be mindful of cold starts and connection limits.
// For Twilio Functions, it's generally fine as the environment persists between invocations for a short period.
// However, if this script is imported by many functions, each might try to init.
// The singleton pattern in getPool() handles this.
// getPool(); // Optionally pre-initialize.
// It's often better to let it initialize on first actual query `query()` or `getClient()` call.

console.log('PostgreSQL DB client utility loaded.');
