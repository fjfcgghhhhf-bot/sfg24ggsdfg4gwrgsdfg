// Transactions serialize wagers and payouts across overlapping Render deploys.
export async function createPostgresStore(game,connectionString,{pool:injectedPool}={}) {
  const {Pool}=await import('pg');
  const pool=injectedPool || new Pool({connectionString,max:3,connectionTimeoutMillis:8000,idleTimeoutMillis:30000});
  await pool.query('CREATE SEQUENCE IF NOT EXISTS upgrade_record_version');
  await pool.query('CREATE TABLE IF NOT EXISTS upgrade_records (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, version bigint NOT NULL, PRIMARY KEY(kind,id))');
  await pool.query('CREATE INDEX IF NOT EXISTS upgrade_records_version ON upgrade_records(version)');
  let cursor=0,queue=Promise.resolve();
  async function execute(fn) {
    const client=await pool.connect();let result,operationError;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724902341)');
      const rows=await client.query('SELECT kind,id,data,version FROM upgrade_records WHERE version > $1 ORDER BY version',[cursor]);
      game.hydrate(rows.rows,{clear:cursor===0});
      for(const row of rows.rows)cursor=Number(row.version);
      try {result=fn();}catch(error){operationError=error;}
      for(const change of game.takeChanges()) {
        const saved=await client.query("INSERT INTO upgrade_records(kind,id,data,version) VALUES($1,$2,$3,nextval('upgrade_record_version')) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data,version=EXCLUDED.version RETURNING version",[change.kind,change.id,JSON.stringify(change.data)]);
        cursor=Number(saved.rows[0].version);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});cursor=0;game.takeChanges();throw error;}
    finally {client.release();}
    if(operationError)throw operationError;
    return result;
  }
  return {
    run(fn){const next=queue.then(()=>execute(fn));queue=next.catch(()=>{});return next;},
    async close(){await queue;await pool.end();},
  };
}
