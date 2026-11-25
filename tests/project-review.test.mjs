import assert from 'node:assert/strict';
import test from 'node:test';
import { renameProject, reviewNames, suggestProjectName } from '../lib/project-names.mjs';
import { readPastTasks } from '../lib/history-review.mjs';
import { ingest, settle } from '../lib/tasks.mjs';

test('generic names offered once and renames preserve identities and exact source chats', () => {
  const project = {id:'p', name:'New project 2'};
  const b={projects:[project, {id:'q', name:'Новый проект (3)'}, {id:'r',name:'New Product Studio'}],
    chats:[{id:'one',projectId:'p',title:'Сверстать обложку'}, {id:'two',projectId:'q',title:'Other'}], cards:[]};
  reviewNames(b);
  assert.deepEqual(b.projects.map(p=>p.nameReview),['pending','pending',undefined]);
  assert.equal(suggestProjectName(b.chats.slice(0,1)),'Сверстать обложку');
  renameProject(b,project,'Игры','first',new Set(['one']));
  b.chats[0].title='Renamed chat';
  b.chats.push({id:'later',projectId:'p',title:'New chat'});
  renameProject(b,project,'Карты','second');
  assert.equal(b.chats[0].projectId,project.id);
  assert.equal(project.originalName,'New project 2');
  assert.deepEqual(project.renames[0].chats,[{id:'one',title:'Сверстать обложку'}]);
  assert.deepEqual(project.renames[1].chats.map(c=>c.id),['one','later']);
  b.projects[1].nameReview='kept';
  reviewNames(b);
  assert.equal(b.projects[1].nameReview,'kept');
  assert.equal(project.nameReview,'renamed');
});

test('common name requires shared evidence, unrelated chats remain a manual choice', () => {
  const titles=values=>values.map(title=>({title}));
  assert.equal(suggestProjectName(titles(['Найти Atlas Press','Обсудить Atlas Press','Проверить Atlas Press'])),'Atlas Press');
  assert.equal(suggestProjectName(titles(['Архив заметок','Проверить расписание','Оформить буклет'])),'');
  assert.equal(suggestProjectName([]),'');
});

const user=(id,text)=>({ id, type:'userMessage', content:[{type:'text',text}] });
const final=(id,text)=>({ id,type:'agentMessage',phase:'final_answer',text });
const turn=(n,...items)=>({ id:'t'+n,status:'completed',completedAt:n,items });
test('historical review pages completed turns, drops covered work and ignores commands in tools or code', async () => {
  const pages=[
    [turn(5,final('done','Проверил форму.')), turn(4,final('next','Следующий шаг — подготовить обложку.'))],
    [turn(3,final('listed','TODO: проверить форму.')),turn(2,user('later','На будущее — добавить экспорт CSV.'))],
    [turn(1,user('plain','Добавь фильтр'),final('code','Пример:\n\x60\x60\x60text\nTODO: добавить команду\n\x60\x60\x60'),
      {type:'commandExecution',id:'tool',text:'TODO: создать задачу'}),{...turn(6,user('working','Add task: ship early')),status:'inProgress'}]
  ];
  const client={request:async(method,args)=>{
    assert.equal(method,'thread/turns/list');
    assert.equal(args.itemsView,'summary');
    const i=Number(args.cursor || 0);
    return {data:pages[i],nextCursor:i+1<pages.length?String(i+1):null};
  }};
  const result=await readPastTasks(client,{id:'chat'});
  assert.equal(result.turns,5);
  assert.deepEqual(result.tasks.map(t=>t.title),['Подготовить обложку','Добавить экспорт CSV']);
  const board={projects:[{id:'p'}],cards:[],chats:[{id:'chat',projectId:'p'}],nextNumber:1};
  for (const task of result.tasks) ingest(board,{...task,projectId:'p'});
  settle(board,board.proposals[0],'dismiss');
  for (const task of (await readPastTasks(client,{id:'chat'})).tasks) ingest(board,{...task,projectId:'p'});
  assert.deepEqual(board.proposals.map(p=>p.state),['dismissed','pending']);
  assert.ok(board.proposals.every(p=>p.source.history && p.source.session==='chat' && p.source.turnId));
  assert.equal(board.cards.length,0);
});
