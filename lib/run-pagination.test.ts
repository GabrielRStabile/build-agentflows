import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./flow-types";
import { template } from "./flow-types";
import { parseRunPage } from "./run-page";
import { createTenantFlow, putTenantRun, tenantRunPage, getTenantRun } from "./tenant-flows";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { GET } from "../app/api/runs/route";
const tenant = await createTenantTestContext();
test.after(tenant.close);
const [a,b] = await tenant.asTenant(async () => [await createTenantFlow("A"), await createTenantFlow("B")]);
await tenant.asTenant(async () => {
  for(let i=0;i<135;i++) await putTenantRun({id:`run-${i}`,flowId:i%2 ? b.id:a.id,name:`Execução ${i}`,status:i%3 ? "completed":"failed",version:1,demo:true,input:"Entrada ".repeat(1000),output:"Saída pesada ".repeat(1000),graph:template(),state:{secret:"dados volumosos"},outputs:{},visits:{},trace:[],next:null,createdAt:new Date(1700000000000+i*1000).toISOString(),updatedAt:""} satisfies Run);
});
const get = (query: string) => tenant.connect(() => GET(tenant.request(`/api/runs?${query}`)));
test("paginação acessa mais de 100 execuções sem duplicar registros ou enviar conteúdo pesado", async()=>{
  const seen:string[]=[];
  for(let page=1;page<=7;page++){
    const response=await get(`page=${page}&pageSize=20`);assert.equal(response.status,200);
    const data=parseRunPage(await response.json());assert.equal(data.total,135);assert.equal(data.totalPages,7);assert.ok(data.items.length<=20);
    for(const r of data.items){seen.push(r.id);assert.ok(r.input.length<=100);for(const key of ["graph","output","trace","state"]) assert.equal(key in r,false);}
  }
  assert.equal(new Set(seen).size,135);assert.equal(seen[0],"run-134");assert.equal(seen.at(-1),"run-0");
  assert.ok((await tenant.asTenant(() => getTenantRun("run-0"))).input.length>100);
});
test("filtro no servidor, fluxo, tamanho, última página e resultado vazio preservam totais corretos",()=>tenant.asTenant(async()=>{
  const failed=await tenantRunPage({pageSize:20,status:"failed"});assert.equal(failed.total,45);assert.equal(failed.totalPages,3);assert.ok(failed.items.every(r=>r.status==="failed"));
  const combined=await tenantRunPage({flowId:a.id,status:"failed",pageSize:10});assert.equal(combined.total,23);assert.ok(combined.items.every(r=>r.flowId===a.id));
  const last=await tenantRunPage({page:999,pageSize:50});assert.equal(last.page,3);assert.equal(last.items.length,35);
  const empty=await tenantRunPage({status:"waiting"});assert.equal(empty.total,0);assert.equal(empty.page,1);assert.deepEqual(empty.items,[]);
}));
test("parâmetros inválidos são recusados e o contrato do editor é preservado",async()=>{
  for(const query of ["page=0","page=-1","page=abc","page=1.1","pageSize=1000000","pageSize=0","status=invalid"]){assert.equal((await get(query)).status,400);}
  const editor=await(await get(`flowId=${b.id}`)).json();assert.ok(Array.isArray(editor));assert.ok(editor[0].graph);
  const anonymous = await tenant.connect(() => GET(new Request("https://app.example.com/api/runs")));
  assert.equal(anonymous.status,401);
});

test("lista por ids em uma requisição, limite na lista do editor e 204 quando a execução não mudou", async () => {
  const { GET: getRun } = await import("../app/api/runs/[id]/route");
  const byIds = await get("ids=run-1,run-2,desconhecida,run-1");
  assert.equal(byIds.status, 200);
  const items = await byIds.json() as Run[];
  assert.deepEqual(items.map((r) => r.id), ["run-1", "run-2"]);
  assert.ok(items[0].trace !== undefined && items[0].graph !== undefined);
  const limited = await get(`flowId=${a.id}&limit=3`);
  assert.equal(limited.status, 200);
  assert.equal((await limited.json() as Run[]).length, 3);
  assert.equal((await get(`flowId=${a.id}&limit=500`)).status, 400);
  const one = (await tenant.asTenant(() => getTenantRun("run-3")));
  const read = (after?: string) => tenant.connect(() => getRun(tenant.request(`/api/runs/run-3${after ? `?after=${encodeURIComponent(after)}` : ""}`), { params: Promise.resolve({ id: "run-3" }) }));
  assert.equal((await read()).status, 200);
  assert.equal((await read(one.updatedAt)).status, 204);
  assert.equal((await read("2000-01-01T00:00:00.000Z")).status, 200);
  const other = await tenant.asTenant(() => putTenantRun({ ...one, id: "run-queued", status: "running", queued: true, createdAt: new Date().toISOString() }));
  assert.equal((await tenant.connect(() => getRun(tenant.request(`/api/runs/run-queued?after=${encodeURIComponent(other.updatedAt)}`), { params: Promise.resolve({ id: "run-queued" }) }))).status, 200);
});
