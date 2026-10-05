const {Client}=require('pg');
const {parse}=require('pg-connection-string');
const {assert,crypto,cleanEnv}=require('./common.cjs');
// Dedicated preparation process only; never mutate the app/workflow environment.
// pg otherwise consults inherited PGOPTIONS, PGPASSWORD, PGSSLMODE, etc.
for(const k of Object.keys(process.env))if(k.startsWith('PG'))delete process.env[k];
const fp=c=>crypto.createHash('sha256').update(JSON.stringify([c.host,String(c.port),c.database])).digest('hex');
function parseConfig(url){
 const u=new URL(url);assert(['postgres:','postgresql:'].includes(u.protocol));
 for(const k of u.searchParams.keys())assert(['ssl','sslmode'].includes(k),'Unsupported URL option');
 const p=parse(url);
 for(const k of Object.keys(p))assert(['host','port','database','user','password','ssl','sslmode'].includes(k),'Unsupported connection option');
 assert(p.host&&p.database&&p.user,'Explicit connection identity required');
 const ssl=p.ssl??false;
 // Node's default trust store and libpq trust roots are not provably identical.
 // Never guess equivalence or downgrade verification.
 if(ssl!==false&&!(typeof ssl==='object'&&ssl.rejectUnauthorized===false&&Object.keys(ssl).length===1))
 throw new Error('TLS_MAPPING_GAP: verified Node TLS trust roots/options need an explicit equivalent libpq mapping');
 const config={host:p.host,port:Number(p.port||5432),database:p.database,user:p.user,password:p.password??'',ssl,connectionTimeoutMillis:5000};
 assert(Number.isInteger(config.port)&&config.port>0&&config.port<65536);
 const effective=new Client(config).connectionParameters;
 assert.equal(effective.host,config.host);assert.equal(effective.database,config.database);assert.equal(effective.password??'',config.password);
 return {config,endpoint:fp(config),tls:{encrypted:!!ssl,verifiesCertificate:false,libpqMode:ssl?'require':'disable'}};
}
let cached,attempted=false;
function workspace(){if(!attempted){attempted=true;cached=parseConfig(process.env.DATABASE_URL);}assert(cached,'Configuration unavailable');return cached;}
function libpq(c){
 return {...cleanEnv(),PGHOST:c.host,PGPORT:String(c.port),PGDATABASE:c.database,PGUSER:c.user,PGPASSWORD:c.password??'',PGSSLMODE:c.ssl?'require':'disable',PGCONNECT_TIMEOUT:'5'};
}
function freshness(e,now=Date.now()){
 assert(e?.environment==='development'&&e.source==='native executeSql');
 assert(e.success&&e.rollback);
 const age=now-Date.parse(e.at);assert(Number.isFinite(age)&&age>=0&&age<=300000,'Binding outside five-minute freshness window');
}
module.exports={parseConfig,workspace,libpq,fp,freshness};