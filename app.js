const P2P_ROOM_ID = 'global-48h-feed';
const POST_TTL = 48 * 60 * 60 * 1000;
const STORAGE_KEY = 'broken-society-state-v1';
const PROFILE_KEY = 'broken-society-profile-v1';
const CLIENT_ID = localStorage.getItem('bs-client-id') || crypto.randomUUID();
localStorage.setItem('bs-client-id', CLIENT_ID);

const icons = {home:'⌂',discover:'⌕',reels:'▶',notifications:'◉',bookmarks:'◆',profile:'●',settings:'⚙'};
const now = () => Date.now();
const escapeHtml = s => String(s ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const randomCode = () => Math.random().toString(36).slice(2,10).toUpperCase();
const initials = name => (name || 'Anonymous').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const timeAgo = ts => { const s=Math.max(1,Math.floor((now()-ts)/1000)); if(s<60)return `${s}s`; const m=Math.floor(s/60); if(m<60)return `${m}m`; const h=Math.floor(m/60); if(h<24)return `${h}h`; return `${Math.floor(h/24)}d`; };
const timeLeft = ts => { const ms=ts+POST_TTL-now(); if(ms<=0)return 'expired'; const h=Math.floor(ms/3600000); const m=Math.floor((ms%3600000)/60000); return h>0?`${h}h left`:`${m}m left`; };

const defaultProfile = {
  id: CLIENT_ID,
  name: 'New Citizen',
  handle: `citizen_${CLIENT_ID.slice(0,5)}`,
  bio: 'Watching the feed fracture in real time.',
  avatar: '',
  createdAt: now(),
  updatedAt: now()
};

let state = loadState();
let profile = {...defaultProfile,...JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}')};
state.profiles[profile.id] = profile;
let ui = {view:'home', feed:'for-you', activeProfile:null, expandedReplies:new Set(), composerMedia:null, status:'connecting', peers:0, toast:'', deepLink:null};
let channel = null;
let room = null;
let sendSnapshot = null, sendMutation = null, sendRequest = null, sendResponse = null;

function emptyState(){return {posts:{},profiles:{},follows:{},friends:{},blocks:{},bookmarks:{},notifications:{},readNotifications:{}}}
function loadState(){try{return {...emptyState(),...JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}}catch{return emptyState()}}
function saveState(){cleanup();localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}
function cleanup(){
  for(const [id,p] of Object.entries(state.posts)) if((p.createdAt||0)+POST_TTL<=now()) delete state.posts[id];
}
function isBlocked(userId){return !!state.blocks[`${profile.id}:${userId}`]}
function visiblePosts(){
  cleanup();
  let posts=Object.values(state.posts).filter(p=>!isBlocked(p.authorId));
  if(ui.feed==='following') posts=posts.filter(p=>state.follows[`${profile.id}:${p.authorId}`]);
  if(ui.feed==='friends') posts=posts.filter(p=>state.friends[`${profile.id}:${p.authorId}`]);
  if(ui.feed==='media') posts=posts.filter(p=>p.media?.type);
  return posts.sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt));
}
function mergeEntity(bucket, incoming){
  if(!incoming?.id) return false;
  const prev=state[bucket][incoming.id];
  const nextTs=incoming.updatedAt||incoming.createdAt||0;
  const prevTs=prev?.updatedAt||prev?.createdAt||0;
  if(!prev || nextTs>=prevTs){state[bucket][incoming.id]=incoming;return true}
  return false;
}
function mergePayload(payload){
  let changed=false;
  for(const bucket of ['posts','profiles','follows','friends','blocks','bookmarks','notifications']){
    for(const entity of Object.values(payload?.[bucket]||{})) changed=mergeEntity(bucket,entity)||changed;
  }
  if(changed){saveState();render()}
}
function snapshot(){cleanup();return {posts:state.posts,profiles:state.profiles,follows:state.follows,friends:state.friends,blocks:state.blocks,bookmarks:state.bookmarks,notifications:state.notifications}}
function publish(bucket, entity){mergeEntity(bucket,entity);saveState();broadcast({kind:'mutation',bucket,entity});render()}
function broadcast(msg){
  channel?.postMessage({...msg,from:CLIENT_ID});
  if(sendMutation && msg.kind==='mutation') sendMutation(msg);
  if(sendSnapshot && msg.kind==='snapshot') sendSnapshot(msg.payload);
  if(sendRequest && msg.kind==='request') sendRequest(msg.payload);
  if(sendResponse && msg.kind==='response') sendResponse(msg.payload);
}
function toast(text){ui.toast=text;render();setTimeout(()=>{ui.toast='';render()},1800)}

function initLocalChannel(){
  channel = new BroadcastChannel('broken-society-global');
  channel.onmessage = e => { const msg=e.data;if(!msg||msg.from===CLIENT_ID)return;handleMessage(msg,true) };
  channel.postMessage({kind:'hello',from:CLIENT_ID});
}
function handleMessage(msg, local=false){
  if(msg.kind==='hello'){ui.peers=Math.max(ui.peers,1);ui.status='ready';broadcast({kind:'snapshot',payload:snapshot()});render()}
  if(msg.kind==='snapshot') mergePayload(msg.payload);
  if(msg.kind==='mutation') {mergeEntity(msg.bucket,msg.entity);saveState();render()}
  if(msg.kind==='request') {
    if(msg.payload?.all) broadcast({kind:'snapshot',payload:snapshot()});
    if(msg.payload?.shareCode){const post=Object.values(state.posts).find(p=>p.shareCode===msg.payload.shareCode);if(post)broadcast({kind:'response',payload:{post}})}
  }
  if(msg.kind==='response' && msg.payload?.post){mergeEntity('posts',msg.payload.post);saveState();render()}
}
async function initP2P(){
  initLocalChannel();
  try{
    const { joinRoom } = await import('https://esm.run/trystero/torrent');
    room = joinRoom({appId:'broken-society-p2p-v1'},P2P_ROOM_ID);
    let onSnapshot, onMutation, onRequest, onResponse;
    [sendSnapshot, onSnapshot] = room.makeAction('snapshot');
    [sendMutation, onMutation] = room.makeAction('mutation');
    [sendRequest, onRequest] = room.makeAction('request');
    [sendResponse, onResponse] = room.makeAction('response');
    onSnapshot((payload)=>mergePayload(payload));
    onMutation((msg)=>handleMessage(msg));
    onRequest((payload)=>handleMessage({kind:'request',payload}));
    onResponse((payload)=>handleMessage({kind:'response',payload}));
    room.onPeerJoin(()=>{ui.peers++;ui.status='ready';sendSnapshot(snapshot());sendRequest({all:true});render()});
    room.onPeerLeave(()=>{ui.peers=Math.max(0,ui.peers-1);render()});
    setTimeout(()=>{if(ui.status==='connecting')ui.status=navigator.onLine?'ready':'offline';render()},1800);
  }catch(err){ui.status=navigator.onLine?'retrying':'offline';render();setTimeout(()=>{ui.status='ready';render()},1600)}
}

function avatarHTML(p,size=''){return `<div class="avatar ${size}">${p?.avatar?`<img src="${p.avatar}" alt="">`:escapeHtml(initials(p?.name))}</div>`}
function postCard(post, nested=false){
  const author=state.profiles[post.authorId]||{id:post.authorId,name:'Unknown peer',handle:'missing'};
  const likes=Object.keys(post.reactions||{}).length;
  const replies=Object.values(state.posts).filter(p=>p.parentId===post.id && !isBlocked(p.authorId));
  const reacted=!!post.reactions?.[profile.id];
  const bookmarked=!!state.bookmarks[`${profile.id}:${post.id}`];
  const hot=replies.length>=5;
  return `<article class="post" data-post="${post.id}">
    <div class="post-head">${avatarHTML(author)}<div class="post-author"><div class="name-line"><strong class="open-profile" data-user="${author.id}">${escapeHtml(author.name)}</strong><span class="handle">@${escapeHtml(author.handle)}</span>${state.friends[`${profile.id}:${author.id}`]?'<span class="badge">friend</span>':''}<span class="post-time">· ${timeAgo(post.createdAt)}</span></div></div><button class="post-menu" data-menu="${post.id}">•••</button></div>
    <div class="post-body">${post.quote?`<div class="quote">${escapeHtml(post.quote)}</div>`:''}<div class="post-text">${escapeHtml(post.text)}</div>${mediaHTML(post.media)}<div class="expiry ${hot?'hot':''}">${hot?'🔥 heated thread · ':''}${timeLeft(post.createdAt)}</div></div>
    <div class="post-actions">
      <button class="post-action ${reacted?'active':''}" data-action="like" data-id="${post.id}">♥ <span>${likes||''}</span></button>
      <button class="post-action" data-action="reply" data-id="${post.id}">↩ <span>${replies.length||''}</span></button>
      <button class="post-action" data-action="share" data-id="${post.id}">↗</button>
      <button class="post-action ${bookmarked?'active':''}" data-action="bookmark" data-id="${post.id}">◆</button>
      <button class="post-action" data-action="more" data-id="${post.id}">⋯</button>
    </div>
    ${ui.expandedReplies.has(post.id)?replyComposer(post):''}
    ${replies.length?`<div class="thread">${replies.slice(0,ui.expandedReplies.has(post.id)?99:2).map(r=>postCard(r,true)).join('')}${replies.length>2&&!ui.expandedReplies.has(post.id)?`<button class="secondary" data-action="show-replies" data-id="${post.id}">Show ${replies.length-2} more replies</button>`:''}</div>`:''}
  </article>`
}
function mediaHTML(media){if(!media?.src)return '';if(media.type==='video')return `<div class="post-media"><video src="${media.src}" controls muted playsinline></video></div>`;return `<div class="post-media"><img src="${media.src}" alt="Post media"></div>`}
function replyComposer(post){return `<div class="reply-box"><input data-reply-input="${post.id}" placeholder="Write a reply"><button class="primary" data-action="send-reply" data-id="${post.id}">Reply</button></div>`}

function layout(content,title='Home',tabs=''){
  return `<div class="app-shell">
  <aside class="sidebar"><div class="brand"><div class="brand-mark">B</div><span>Broken Society</span></div>${navHTML()}<button class="new-post" data-new-post>Post</button><div class="sidebar-user" data-edit-profile>${avatarHTML(profile)}<div class="user-meta"><strong>${escapeHtml(profile.name)}</strong><span>@${escapeHtml(profile.handle)}</span></div></div></aside>
  <main class="main"><header class="topbar"><h1>${escapeHtml(title)}</h1>${statusHTML()}</header>${tabs}${content}</main>
  <aside class="rightbar">${rightbarHTML()}</aside>
  ${mobileNavHTML()}</div>${ui.toast?`<div class="toast">${escapeHtml(ui.toast)}</div>`:''}`;
}
function navHTML(){return `<nav class="nav">${[['home','Home'],['discover','Discover'],['reels','Reels'],['notifications','Notifications'],['bookmarks','Bookmarks'],['profile','Profile']].map(([v,l])=>`<button class="nav-btn ${ui.view===v?'active':''}" data-view="${v}"><span class="nav-icon">${icons[v]}</span><span class="nav-label">${l}</span></button>`).join('')}</nav>`}
function mobileNavHTML(){return `<nav class="mobile-nav">${['home','discover','reels','notifications','profile'].map(v=>`<button class="${ui.view===v?'active':''}" data-view="${v}">${icons[v]}</button>`).join('')}</nav>`}
function statusHTML(){return `<div class="status-pill ${ui.status}"><span class="status-dot"></span><span class="status-copy">${ui.status} · </span><strong>${ui.peers}</strong> peer${ui.peers===1?'':'s'}</div>`}
function tabsHTML(){return `<div class="tabs">${[['for-you','For you'],['following','Following'],['friends','Friends'],['media','Media']].map(([id,l])=>`<button class="tab ${ui.feed===id?'active':''}" data-feed="${id}">${l}</button>`).join('')}</div>`}
function composerHTML(){return `<section class="composer"><div class="composer-head">${avatarHTML(profile)}<textarea id="composerText" maxlength="1000" placeholder="What is breaking today?"></textarea></div><div class="dropzone" id="dropzone">Drop an image, GIF, or MP4 here — or click to browse<input id="mediaInput" type="file" accept="image/*,video/mp4" hidden></div><div class="media-preview" id="mediaPreview">${ui.composerMedia?mediaHTML(ui.composerMedia):''}</div><div class="composer-actions"><div class="action-row"><button class="icon-btn" data-media>▧</button><button class="icon-btn" data-insert="#">#</button><button class="icon-btn" data-insert="@">@</button></div><button class="primary" id="publishPost">Publish</button></div></section>`}
function rightbarHTML(){
  const people=Object.values(state.profiles).filter(p=>p.id!==profile.id&&!isBlocked(p.id)).slice(0,3);
  return `<div class="search"><span>⌕</span><input id="globalSearch" placeholder="Search the chaos"></div><section class="panel"><h3>Live pressure</h3><div class="trend"><small>Trending in the lobby</small><strong>#NoFilter</strong><span>${Object.keys(state.posts).length} active posts</span></div><div class="trend"><small>48-hour pulse</small><strong>Nothing lasts here</strong><span>${ui.peers} peers currently visible</span></div></section><section class="panel"><h3>People in the room</h3><div class="people">${people.length?people.map(p=>`<div class="person">${avatarHTML(p)}<div class="user-meta"><strong>${escapeHtml(p.name)}</strong><span>@${escapeHtml(p.handle)}</span></div><button class="secondary" data-follow="${p.id}">${state.follows[`${profile.id}:${p.id}`]?'Following':'Follow'}</button></div>`).join(''):'<div style="color:#777;font-size:13px">Waiting for peers to appear.</div>'}</div></section>`
}
function homeView(){const posts=visiblePosts().filter(p=>!p.parentId);return layout(`${tabsHTML()}${composerHTML()}<section class="feed">${posts.length?posts.map(p=>postCard(p)).join(''):emptyHTML('The feed is quiet','Open another browser or share the page. New peers will reconcile automatically.')}</section>`,'Home')}
function discoverView(){const posts=Object.values(state.posts).filter(p=>!p.parentId&&!isBlocked(p.authorId)).sort((a,b)=>(Object.keys(b.reactions||{}).length)-(Object.keys(a.reactions||{}).length));return layout(`<section class="feed" style="padding-top:16px">${posts.length?posts.map(postCard).join(''):emptyHTML('Searching peers','Discover fills as live content reaches your browser.')}</section>`,'Discover')}
function reelsView(){const videos=Object.values(state.posts).filter(p=>p.media?.type==='video'&&!isBlocked(p.authorId));return layout(videos.length?`<section class="reels">${videos.map(p=>`<div class="reel"><video src="${p.media.src}" autoplay muted loop playsinline></video><div class="reel-overlay"><div class="reel-info"><strong>@${escapeHtml((state.profiles[p.authorId]||{}).handle||'peer')}</strong><p>${escapeHtml(p.text)}</p><small>${timeLeft(p.createdAt)}</small></div><div class="reel-actions"><button class="reel-action" data-action="like" data-id="${p.id}">♥</button><button class="reel-action" data-action="reply" data-id="${p.id}">↩</button><button class="reel-action" data-action="share" data-id="${p.id}">↗</button></div></div></div>`).join('')}</section>`:emptyHTML('No reels yet','Post an MP4 to start the vertical video feed.'),'Reels')}
function notificationsView(){const items=Object.values(state.notifications).filter(n=>n.to===profile.id).sort((a,b)=>b.createdAt-a.createdAt);return layout(`<section>${items.length?items.map(n=>`<div class="notification ${state.readNotifications[n.id]?'':'unread'}"><div class="notification-icon">${n.type==='reaction'?'♥':n.type==='reply'?'↩':'●'}</div><div><p>${escapeHtml(n.text)}</p><time>${timeAgo(n.createdAt)} ago</time></div></div>`).join(''):emptyHTML('No signals yet','Follows, reactions, replies and mentions will appear here.')}</section>`,'Notifications')}
function bookmarksView(){const posts=Object.values(state.bookmarks).filter(b=>b.userId===profile.id).map(b=>state.posts[b.postId]).filter(Boolean);return layout(`<section class="feed" style="padding-top:16px">${posts.length?posts.map(postCard).join(''):emptyHTML('Nothing saved','Bookmark posts to keep them visible until their 48-hour expiry.')}</section>`,'Bookmarks')}
function profileView(userId=profile.id){const p=state.profiles[userId]||profile;const own=p.id===profile.id;const posts=Object.values(state.posts).filter(x=>x.authorId===p.id&&!x.parentId).sort((a,b)=>b.createdAt-a.createdAt);const followers=Object.values(state.follows).filter(f=>f.targetId===p.id&&!f.deleted).length;const following=Object.values(state.follows).filter(f=>f.userId===p.id&&!f.deleted).length;const friends=Object.values(state.friends).filter(f=>f.userId===p.id&&!f.deleted).length;return layout(`<div class="profile-cover"></div><section class="profile-info"><div class="profile-top">${avatarHTML(p,'profile-avatar')}<div class="profile-actions">${own?`<button class="secondary" data-edit-profile>Edit profile</button>`:`<button class="secondary" data-follow="${p.id}">${state.follows[`${profile.id}:${p.id}`]?'Following':'Follow'}</button><button class="secondary" data-friend="${p.id}">${state.friends[`${profile.id}:${p.id}`]?'Friend':'Add friend'}</button><button class="secondary" data-block="${p.id}">Block</button>`}</div></div><h2>${escapeHtml(p.name)}</h2><div class="handle">@${escapeHtml(p.handle)}</div><p class="profile-bio">${escapeHtml(p.bio)}</p><div class="stats"><div class="stat"><strong>${followers}</strong><span>followers</span></div><div class="stat"><strong>${following}</strong><span>following</span></div><div class="stat"><strong>${friends}</strong><span>friends</span></div></div></section><section class="feed" style="padding-top:16px">${posts.length?posts.map(postCard).join(''):emptyHTML('No recent posts','This profile has no unexpired posts.')}</section>`,'Profile')}
function emptyHTML(title,text){return `<div class="empty"><div class="symbol">⌁</div><h3>${title}</h3><p>${text}</p></div>`}
function render(){
  const root=document.getElementById('app');
  root.innerHTML=ui.view==='home'?homeView():ui.view==='discover'?discoverView():ui.view==='reels'?reelsView():ui.view==='notifications'?notificationsView():ui.view==='bookmarks'?bookmarksView():profileView(ui.activeProfile||profile.id);
  bindEvents();
}

function bindEvents(){
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{ui.view=b.dataset.view;ui.activeProfile=null;if(ui.view==='notifications'){for(const n of Object.values(state.notifications))if(n.to===profile.id)state.readNotifications[n.id]=true;saveState()}render()});
  document.querySelectorAll('[data-feed]').forEach(b=>b.onclick=()=>{ui.feed=b.dataset.feed;render()});
  document.querySelectorAll('.open-profile').forEach(b=>b.onclick=()=>{ui.view='profile';ui.activeProfile=b.dataset.user;render()});
  document.querySelectorAll('[data-follow]').forEach(b=>b.onclick=()=>toggleGraph('follows',b.dataset.follow));
  document.querySelectorAll('[data-friend]').forEach(b=>b.onclick=()=>toggleGraph('friends',b.dataset.friend));
  document.querySelectorAll('[data-block]').forEach(b=>b.onclick=()=>blockUser(b.dataset.block));
  document.querySelectorAll('[data-edit-profile]').forEach(b=>b.onclick=openProfileEditor);
  document.querySelectorAll('[data-new-post]').forEach(b=>b.onclick=()=>{ui.view='home';render();setTimeout(()=>document.getElementById('composerText')?.focus(),0)});
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>handlePostAction(b.dataset.action,b.dataset.id));
  const publish=document.getElementById('publishPost');if(publish)publish.onclick=createPost;
  const input=document.getElementById('mediaInput'),drop=document.getElementById('dropzone');
  if(input)input.onchange=e=>handleFile(e.target.files[0]);
  if(drop){drop.onclick=()=>input.click();drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging')};drop.ondragleave=()=>drop.classList.remove('dragging');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragging');handleFile(e.dataTransfer.files[0])}}
  document.querySelectorAll('[data-media]').forEach(b=>b.onclick=()=>input?.click());
  document.querySelectorAll('[data-insert]').forEach(b=>b.onclick=()=>{const t=document.getElementById('composerText');t.value+=b.dataset.insert;t.focus()});
  document.querySelectorAll('.reel video').forEach(v=>v.onclick=()=>v.muted=!v.muted);
}
function handleFile(file){if(!file)return;if(file.size>8*1024*1024){toast('Media must be under 8 MB');return}const reader=new FileReader();reader.onload=()=>{ui.composerMedia={type:file.type.startsWith('video')?'video':'image',src:reader.result,name:file.name};render()};reader.readAsDataURL(file)}
function createPost(){const text=document.getElementById('composerText')?.value.trim()||'';if(!text&&!ui.composerMedia)return;const id=crypto.randomUUID();const post={id,authorId:profile.id,text,media:ui.composerMedia,createdAt:now(),updatedAt:now(),reactions:{}};publish('posts',post);ui.composerMedia=null;toast('Post broadcast to connected peers')}
function handlePostAction(action,id){const post=state.posts[id];if(!post)return;
  if(action==='like'){post.reactions=post.reactions||{};post.reactions[profile.id]?delete post.reactions[profile.id]:post.reactions[profile.id]=now();post.updatedAt=now();publish('posts',post);if(post.authorId!==profile.id)notify(post.authorId,'reaction',`${profile.name} reacted to your post.`)}
  if(action==='reply'||action==='show-replies'){ui.expandedReplies.add(id);render();setTimeout(()=>document.querySelector(`[data-reply-input="${id}"]`)?.focus(),0)}
  if(action==='send-reply'){const inp=document.querySelector(`[data-reply-input="${id}"]`);const text=inp?.value.trim();if(!text)return;const reply={id:crypto.randomUUID(),authorId:profile.id,parentId:id,text,quote:post.text.slice(0,140),createdAt:now(),updatedAt:now(),reactions:{}};publish('posts',reply);notify(post.authorId,'reply',`${profile.name} replied: ${text.slice(0,80)}`)}
  if(action==='share'){if(!post.shareCode){post.shareCode=randomCode();post.updatedAt=now();publish('posts',post)}const url=`${location.origin}${location.pathname}#post/${post.shareCode}`;navigator.clipboard?.writeText(url);history.replaceState(null,'',`#post/${post.shareCode}`);toast('Share link copied')}
  if(action==='bookmark'){const key=`${profile.id}:${id}`;if(state.bookmarks[key])delete state.bookmarks[key];else state.bookmarks[key]={id:key,userId:profile.id,postId:id,createdAt:now(),updatedAt:now()};saveState();render()}
  if(action==='more'){const authorId=post.authorId;if(authorId===profile.id){if(confirm('Delete this post?')){delete state.posts[id];saveState();render()}}else if(confirm('Block this user and hide all their content?'))blockUser(authorId)}
}
function toggleGraph(bucket,targetId){const key=`${profile.id}:${targetId}`;if(state[bucket][key])delete state[bucket][key];else state[bucket][key]={id:key,userId:profile.id,targetId,createdAt:now(),updatedAt:now()};saveState();broadcast({kind:'snapshot',payload:snapshot()});if(bucket==='follows'&&!state[bucket][key]){}else notify(targetId,bucket==='follows'?'follow':'friend',`${profile.name} ${bucket==='follows'?'followed you':'added you as a friend'}.`);render()}
function blockUser(targetId){const key=`${profile.id}:${targetId}`;state.blocks[key]={id:key,userId:profile.id,targetId,createdAt:now(),updatedAt:now()};delete state.follows[key];delete state.friends[key];saveState();broadcast({kind:'snapshot',payload:snapshot()});ui.view='home';ui.activeProfile=null;render();toast('User blocked')}
function notify(to,type,text){const n={id:crypto.randomUUID(),to,from:profile.id,type,text,createdAt:now(),updatedAt:now()};publish('notifications',n)}
function openProfileEditor(){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="profileModal"><div class="modal"><h2>Edit profile</h2><div class="form-grid"><div class="field"><label>Name</label><input id="editName" value="${escapeHtml(profile.name)}"></div><div class="field"><label>Handle</label><input id="editHandle" value="${escapeHtml(profile.handle)}"></div><div class="field"><label>Bio</label><textarea id="editBio">${escapeHtml(profile.bio)}</textarea></div><div class="field"><label>Avatar image</label><input id="editAvatar" type="file" accept="image/*"></div></div><div class="modal-actions"><button class="secondary" id="cancelEdit">Cancel</button><button class="primary" id="saveEdit">Save profile</button></div></div></div>`);
  document.getElementById('cancelEdit').onclick=()=>document.getElementById('profileModal').remove();
  document.getElementById('saveEdit').onclick=()=>{const file=document.getElementById('editAvatar').files[0];const finish=avatar=>{profile={...profile,name:document.getElementById('editName').value.trim()||profile.name,handle:(document.getElementById('editHandle').value.trim()||profile.handle).replace(/^@/,''),bio:document.getElementById('editBio').value.trim(),avatar:avatar??profile.avatar,updatedAt:now()};localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));publish('profiles',profile);document.getElementById('profileModal').remove();render()};if(file){const r=new FileReader();r.onload=()=>finish(r.result);r.readAsDataURL(file)}else finish()};
}
function resolveDeepLink(){const m=location.hash.match(/^#post\/(\w{8})$/);if(!m)return;const code=m[1].toUpperCase();const post=Object.values(state.posts).find(p=>p.shareCode===code);if(post){ui.view='home';ui.feed='for-you';ui.deepLink=post.id;render();setTimeout(()=>document.querySelector(`[data-post="${post.id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'}),100)}else{ui.status='connecting';render();broadcast({kind:'request',payload:{shareCode:code}});setTimeout(()=>{const found=Object.values(state.posts).find(p=>p.shareCode===code);if(!found)toast('Still searching connected peers for this post')},1600)}}
window.addEventListener('online',()=>{ui.status='ready';render()});window.addEventListener('offline',()=>{ui.status='offline';render()});
render();initP2P();resolveDeepLink();setInterval(()=>{cleanup();saveState();render()},60000);
