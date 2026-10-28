let token = '', busy = false, organizations = [], selectedOrg = '', subject='';
const labels = {DRAFT:'Черновик',APPROVED:'Тестово согласован',SENDING:'Отправка на стенде',UNKNOWN:'Результат неизвестен',REGISTERED:'Зарегистрирован на стенде',REJECTED:'Отклонён',RECEIVED:'Получен',QUARANTINED:'Карантин'};
const errors = {STORAGE_BUSY:"Хранилище занято. Обновите журнал перед повтором действия.",ACCESS_DENIED:'Для этой организации нет права на действие.',UNAUTHENTICATED:'Тестовый principal недействителен. Нужен повторный запуск тестовой сессии.',STALE_APPROVAL:'Согласование устарело. Обновите журнал и согласуйте актуальную версию.',VERSION_CONFLICT:'Документ изменился. Журнал обновлён; проверьте версию перед новым действием.',SCHEMA_UNSUPPORTED:'Форма не поддерживается. Исходные данные сохранены в карантине.',RECOVERED_UNKNOWN:'Попытка прервана. Сначала сверьте статус.',OUTCOME_UNKNOWN:'Ответ не получен. Повторная отправка запрещена.',IDEMPOTENCY_CONFLICT:'Повтор содержит другое тело. Проверьте исходный черновик.',APPROVAL_EXPIRED:'Срок согласования истёк.',ORGANIZATION_REQUIRED:'Выберите доступную организацию.'};
const permitted=action=>organizations.find(o=>o.id===selectedOrg)?.actions.includes(action);
function locks(){for(const b of document.querySelectorAll('button'))b.disabled=busy||Boolean(b.dataset.permission&&!permitted(b.dataset.permission));document.querySelector('#organization').disabled=busy;}
async function api(path, body) {
  const headers={'X-Flowpos-Organization':selectedOrg};
  if(body!==undefined)Object.assign(headers,{'Content-Type':'application/json','X-Flowpos-Local':token});
  const res=await fetch(path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const result=await res.json();if(!res.ok)throw new Error(result.code);return result;
}
function cell(row,text,cls=''){const td=document.createElement('td');td.textContent=text;td.className=cls;row.append(td);return td;}
async function refresh(){
  const docs=await api('/api/documents'),rows=document.querySelector('#rows');rows.replaceChildren();document.querySelector('#empty').hidden=docs.length>0;document.querySelector('#empty').textContent=permitted('draft')?'Документов пока нет. Получите тестовый входящий или создайте черновик.':'В этой организации документов пока нет. Доступно только чтение.';
  for(const d of docs){
    const row=document.createElement('tr');cell(row,d.direction==='IN'?d.externalId:JSON.parse(d.payload).number);cell(row,d.direction==='IN'?'Входящий':'Исходящий');cell(row,labels[d.state]||d.state,`badge status-${d.state.toLowerCase()}`);cell(row,errors[d.errorCode]||d.errorCode||'—');const action=cell(row,'');
    const expired=d.state==='APPROVED'&&d.approvalExpiresAt<=Date.now();
    const kind=d.state==='DRAFT'?'approve':expired?'reset-approval':d.state==='APPROVED'?'send':d.state==='UNKNOWN'?'reconcile':null;
    const permission=kind==='reset-approval'?'approve':kind;
    if(kind&&permitted(permission)){const b=document.createElement('button');b.dataset.permission=permission;b.textContent={approve:'Тестово согласовать',send:'Отправить на стенде',reconcile:'Сверить на стенде','reset-approval':'Согласовать заново'}[kind];b.onclick=()=>run(()=>api(`/api/documents/${d.id}/${kind}`,{expectedVersion:d.version,...(kind==='approve'?{payloadHash:d.payloadHash,expiresAt:Date.now()+120000}:{})}));action.append(b);}
    const details=document.createElement('button');details.className='secondary';details.textContent='Детали';details.onclick=()=>{document.querySelector('#details').hidden=false;document.querySelector('#raw').textContent=JSON.stringify({organization:d.orgId,state:d.state,error:errors[d.errorCode]||d.errorCode,version:d.version,schemaVersion:d.schemaVersion,payloadHash:d.payloadHash,original:d.payload},null,2);};action.append(details);rows.append(row);
  }
  locks();
}
async function run(fn){if(busy)return;busy=true;locks();document.querySelector('#status').textContent='Выполняется…';try{await fn();await refresh();document.querySelector('#status').textContent='Готово. Данные синтетические.';}catch(e){try{if(selectedOrg)await refresh();}catch{}document.querySelector('#status').textContent=errors[e.message]||`Ошибка: ${e.message}`;}finally{busy=false;locks();}}
document.querySelector('#organization').onchange=e=>{selectedOrg=e.target.value;document.querySelector('#details').hidden=true;run(refresh);};
document.querySelector('#import').onclick=()=>run(()=>api('/api/fixtures/inbound',{fixture:'standard'}));
document.querySelector('#unsupported').onclick=()=>run(()=>api('/api/fixtures/inbound',{fixture:'unsupported'}));
document.querySelector('#refresh').onclick=()=>run(refresh);
document.querySelector('#draft').onsubmit=e=>{e.preventDefault();const data=new FormData(e.target),invoice={number:data.get('number'),amountMinor:data.get('amountMinor'),currency:'KZT'},key=`flowpos-stand-pending:${subject}:${selectedOrg}`;run(async()=>{let pending=JSON.parse(sessionStorage.getItem(key)||'null');if(pending&&JSON.stringify(pending.invoice)!==JSON.stringify(invoice))throw new Error('IDEMPOTENCY_CONFLICT');if(!pending){pending={operationId:crypto.randomUUID(),invoice};sessionStorage.setItem(key,JSON.stringify(pending));}await api('/api/outbound',pending);sessionStorage.removeItem(key);});};
run(async()=>{const session=await api('/api/session');token=session.token;organizations=session.organizations;subject=session.subject;document.querySelector('#principal').textContent=`Локальная тестовая роль: ${subject}`;const select=document.querySelector('#organization');for(const org of organizations){const option=document.createElement('option');option.value=org.id;option.textContent=org.id+(org.actions.includes('draft')?'':' · только чтение');select.append(option);}selectedOrg=organizations[0]?.id||'';});
document.querySelector("#restore-pending").onclick=()=>{const pending=JSON.parse(sessionStorage.getItem(`flowpos-stand-pending:${subject}:${selectedOrg}`)||"null");if(pending){document.querySelector("[name=number]").value=pending.invoice.number;document.querySelector("[name=amountMinor]").value=pending.invoice.amountMinor;}document.querySelector("#status").textContent=pending?"Восстановлены исходные данные и operation ID. Повторите создание, чтобы получить прежний результат.":"Незавершённых черновиков нет.";};
