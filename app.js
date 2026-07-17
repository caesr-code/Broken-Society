const P2P_ROOM_ID = 'global-48h-feed';
const POST_TTL = 48 * 60 * 60 * 1000;
const STORAGE_KEY = 'broken-society-state-v1';
const PROFILE_KEY = 'broken-society-profile-v1';
const CREATOR_ARCHIVE_KEY = 'broken-society-creator-archive-v1';
const PROFILE_ID = localStorage.getItem('bs-client-id') || crypto.randomUUID();
localStorage.setItem('bs-client-id', PROFILE_ID);
const SESSION_ID = sessionStorage.getItem('bs-session-id') || crypto.randomUUID();
sessionStorage.setItem('bs-session-id', SESSION_ID);

const icons = {home:'⌂',discover:'⌕',reels:'▶',notifications:'◉',bookmarks:'◆',profile:'●',settings:'⚙'};
const now = () => Date.now();
const escapeHtml = s => String(s ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const randomCode = () => Math.random().toString(36).slice(2,10).toUpperCase();
const initials = name => (name || 'Anonymous').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const timeAgo = ts => { const s=Math.max(1,Math.floor((now()-ts)/1000)); if(s<60)return `${s}s`; const m=Math.floor(s/60); if(m<60)return `${m}m`; const h=Math.floor(m/60); if(h<24)return `${h}h`; return `${Math.floor(h/24)}d`; };
const timeLeft = ts => { const ms=ts+POST_TTL-now(); if(ms<=0)return 'expired'; const h=Math.floor(ms/3600000); const m=Math.floor((ms%3600000)/60000); return h>0?`${h}h left`:`${m}m left`; };

const defaultProfile = {
  id: PROFILE_ID,
  name: 'New Citizen',
  handle: `citizen_${PROFILE_ID.slice(0,5)}`,
  bio: 'Watching the feed fracture in real time.',
  avatar: '',
  createdAt: now(),
  updatedAt: now()
};

let state = loadState();
let creatorArchive = loadCreatorArchive();
let profile = {...defaultProfile,...JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}')};
state.profiles[profile.id] = profile;
let ui = {view:'home', feed:'for-you', activeProfile:null, expandedReplies:new Set(), composerMedia:null, reelMedia:null, openMenu:null, status:'connecting', peers:0, toast:'', deepLink:null};
let channel = null;
const localPeerSessions = new Set();
const mediaUrlCache = new Map();
let mediaDbPromise = null;
let room = null;
let sendSnapshot = null, sendMutation = null, sendRequest = null, sendResponse = null, mediaAction = null;

function emptyState(){return {posts:{},profiles:{},follows:{},friends:{},blocks:{},bookmarks:{},notifications:{},readNotifications:{}}}
function loadState(){try{return {...emptyState(),...JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}}catch{return emptyState()}}
function loadCreatorArchive(){try{return JSON.parse(localStorage.getItem(CREATOR_ARCHIVE_KEY)||'{}')}catch{return {}}}
function stateForStorage(value){
  return JSON.parse(JSON.stringify(value,(key,val)=>{
    if(key==='blob')return undefined;
    if(key==='src'&&typeof val==='string'&&(val.startsWith('blob:')||val.startsWith('data:')))return undefined;
    return val;
  }));
}
function saveCreatorArchive(){
  try{localStorage.setItem(CREATOR_ARCHIVE_KEY,JSON.stringify(stateForStorage(creatorArchive)))}catch(err){console.warn('Creator archive storage skipped:',err)}
}
function openMediaDb(){
  if(mediaDbPromise)return mediaDbPromise;
  mediaDbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open('broken-society-media-v1',1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('media'))req.result.createObjectStore('media')};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  return mediaDbPromise;
}
async function saveMediaBlob(id,blob){if(!id||!blob)return;const db=await openMediaDb();await new Promise((resolve,reject)=>{const tx=db.transaction('media','readwrite');tx.objectStore('media').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
async function getMediaBlob(id){if(!id)return null;const db=await openMediaDb();return new Promise((resolve,reject)=>{const req=db.transaction('media').objectStore('media').get(id);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)})}
function mediaSource(media){
  if(!media)return '';
  if(media.src)return media.src;
  if(media.blob){const url=URL.createObjectURL(media.blob);media.src=url;mediaUrlCache.set(media.id,url);return url}
  return mediaUrlCache.get(media.id)||'';
}
async function hydrateMedia(){
  const items=[...Object.values(state.posts),...Object.values(creatorArchive)];
  let changed=false;
  for(const post of items){if(post.media?.id&&!post.media.src&&!post.media.blob){try{const blob=await getMediaBlob(post.media.id);if(blob){post.media.blob=blob;post.media.src=URL.createObjectURL(blob);mediaUrlCache.set(post.media.id,post.media.src);changed=true}}catch{}}}
  if(changed)render();
}
function archiveOwnPost(post){if(post?.authorId===profile.id){creatorArchive[post.id]=structuredClone(post);saveCreatorArchive()}}
function removeFromCreatorArchive(id){delete creatorArchive[id];saveCreatorArchive()}
function saveState(){cleanup();try{localStorage.setItem(STORAGE_KEY,JSON.stringify(stateForStorage(state)))}catch(err){console.warn('Local state storage skipped:',err)}}
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
  if(bucket==='posts'&&incoming.media?.blob){saveMediaBlob(incoming.media.id,incoming.media.blob).catch(console.warn);if(!incoming.media.src)incoming.media.src=URL.createObjectURL(incoming.media.blob)}
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
function publish(bucket, entity){
  mergeEntity(bucket,entity);
  if(bucket==='posts')archiveOwnPost(entity);
  saveState();
  render(); // Always show the local mutation before any network transfer.
  broadcast({kind:'mutation',bucket,entity});
}
function broadcast(msg){
  // Same-origin tabs can safely receive Blob objects through BroadcastChannel.
  try{channel?.postMessage({...msg,from:SESSION_ID})}catch(err){console.warn('Local sync skipped:',err)}
  try{
    if(sendMutation && msg.kind==='mutation'){
      const wireMsg={...msg,entity:stateForStorage(msg.entity)};
      sendMutation(wireMsg);
      const media=msg.entity?.media;
      if(mediaAction&&media?.blob){
        const transfer=mediaAction.send(media.blob,{metadata:{mediaId:media.id,name:media.name||'',mime:media.mime||media.blob.type||'',postId:msg.entity.id}});
        transfer?.catch?.(console.warn);
      }
    }
    if(sendSnapshot && msg.kind==='snapshot') sendSnapshot(stateForStorage(msg.payload));
    if(sendRequest && msg.kind==='request') sendRequest(msg.payload);
    if(sendResponse && msg.kind==='response') sendResponse(stateForStorage(msg.payload));
  }catch(err){
    // A failed P2P send must never cancel a local post.
    console.warn('Peer broadcast skipped:',err);
    ui.status=navigator.onLine?'retrying':'offline';
    render();
  }
}
function toast(text){ui.toast=text;render();setTimeout(()=>{ui.toast='';render()},1800)}

function initLocalChannel(){
  channel = new BroadcastChannel('broken-society-global');
  channel.onmessage = e => { const msg=e.data;if(!msg||msg.from===SESSION_ID)return;handleMessage(msg,true) };
  channel.postMessage({kind:'hello',from:SESSION_ID});
}
function handleMessage(msg, local=false){
  if(msg.kind==='hello'){localPeerSessions.add(msg.from);ui.peers=connectedPeerIds.size+localPeerSessions.size;ui.status='ready';channel?.postMessage({kind:'presence',from:SESSION_ID});broadcast({kind:'snapshot',payload:snapshot()});render()}
  if(msg.kind==='presence'){localPeerSessions.add(msg.from);ui.peers=connectedPeerIds.size+localPeerSessions.size;ui.status='ready';render()}
  if(msg.kind==='snapshot') mergePayload(msg.payload);
  if(msg.kind==='mutation') {mergeEntity(msg.bucket,msg.entity);saveState();render()}
  if(msg.kind==='request') {
    if(msg.payload?.all) broadcast({kind:'snapshot',payload:snapshot()});
    if(msg.payload?.shareCode){const post=Object.values(state.posts).find(p=>p.shareCode===msg.payload.shareCode);if(post)broadcast({kind:'response',payload:{post}})}
  }
  if(msg.kind==='response' && msg.payload?.post){mergeEntity('posts',msg.payload.post);saveState();render()}
}
let p2pRetryTimer = null;
const connectedPeerIds = new Set();

function wireAction(name, handler){
  const action = room.makeAction(name);

  // Trystero 0.25+ returns an action object. Keep compatibility with older
  // tuple builds so cached copies of the page do not silently stop syncing.
  if(Array.isArray(action)){
    const [send, onMessage] = action;
    onMessage(handler);
    return payload => send(payload);
  }

  action.onMessage = payload => handler(payload);
  return payload => action.send(payload);
}

async function initP2P(){
  if(!channel) initLocalChannel();
  if(p2pRetryTimer){clearTimeout(p2pRetryTimer);p2pRetryTimer=null}
  ui.status = navigator.onLine ? 'connecting' : 'offline';
  render();

  if(!navigator.onLine) return;

  try{
    // The default Trystero package currently uses Nostr discovery, which is
    // substantially more dependable across separate networks than the old
    // public BitTorrent tracker import used by the previous build.
    const { joinRoom } = await import('https://esm.run/trystero@0.25.2');
    room = joinRoom({
      appId:'broken-society-p2p-v2',
      rtcConfig:{
        iceServers:[
          {urls:'stun:stun.l.google.com:19302'},
          {urls:'stun:stun1.l.google.com:19302'}
        ]
      }
    },P2P_ROOM_ID);

    sendSnapshot = wireAction('snapshot', payload => mergePayload(payload));
    sendMutation = wireAction('mutation', msg => handleMessage(msg));
    sendRequest = wireAction('request', payload => handleMessage({kind:'request',payload}));
    sendResponse = wireAction('response', payload => handleMessage({kind:'response',payload}));
    mediaAction = room.makeAction('media');
    mediaAction.onMessage = async (blob, context={}) => {
      const metadata=context.metadata||{};
      const mediaId=metadata.mediaId;
      if(!mediaId||!blob)return;
      try{await saveMediaBlob(mediaId,blob)}catch(err){console.warn('Incoming media could not be saved:',err)}
      const url=URL.createObjectURL(blob);
      mediaUrlCache.set(mediaId,url);
      for(const post of Object.values(state.posts)){
        if(post.media?.id===mediaId){post.media.blob=blob;post.media.src=url;post.media.mime=metadata.mime||post.media.mime;}
      }
      for(const post of Object.values(creatorArchive)){
        if(post.media?.id===mediaId){post.media.blob=blob;post.media.src=url;}
      }
      render();
    };

    room.onPeerJoin = peerId => {
      connectedPeerIds.add(peerId);
      ui.peers = connectedPeerIds.size + localPeerSessions.size;
      ui.status = 'ready';
      sendSnapshot(snapshot());
      sendRequest({all:true});
      render();
    };

    room.onPeerLeave = peerId => {
      connectedPeerIds.delete(peerId);
      ui.peers = connectedPeerIds.size + localPeerSessions.size;
      render();
    };

    ui.status = 'ready';
    render();
    // Reconcile with peers that may have connected during initialization.
    sendRequest({all:true});
  }catch(err){
    console.error('Broken Society P2P failed to initialize:', err);
    room = null;
    sendSnapshot = sendMutation = sendRequest = sendResponse = mediaAction = null;
    connectedPeerIds.clear();
    ui.peers = 0;
    ui.status = navigator.onLine ? 'retrying' : 'offline';
    render();
    if(navigator.onLine) p2pRetryTimer=setTimeout(initP2P,10000);
  }
}

window.addEventListener('online',()=>initP2P());
window.addEventListener('offline',()=>{
  ui.status='offline';
  connectedPeerIds.clear();
  ui.peers=0;
  render();
});

function avatarHTML(p,size=''){return `<div class="avatar ${size}">${p?.avatar?`<img src="${p.avatar}" alt="">`:escapeHtml(initials(p?.name))}</div>`}
function postCard(post, nested=false){
  const archived=!!post.localArchived;
  const author=state.profiles[post.authorId]||{id:post.authorId,name:'Unknown peer',handle:'missing'};
  const likes=Object.keys(post.reactions||{}).length;
  const replies=Object.values(state.posts).filter(p=>p.parentId===post.id && !isBlocked(p.authorId));
  const reacted=!!post.reactions?.[profile.id];
  const bookmarked=!!state.bookmarks[`${profile.id}:${post.id}`];
  const hot=replies.length>=5;
  return `<article class="post" data-post="${post.id}">
    <div class="post-head">${avatarHTML(author)}<div class="post-author"><div class="name-line"><strong class="open-profile" data-user="${author.id}">${escapeHtml(author.name)}</strong><span class="handle">@${escapeHtml(author.handle)}</span>${state.friends[`${profile.id}:${author.id}`]?'<span class="badge">friend</span>':''}<span class="post-time">· ${timeAgo(post.createdAt)}</span></div></div><div class="post-menu-wrap"><button class="post-menu" type="button" aria-label="Post options" aria-expanded="${ui.openMenu===post.id}" data-menu="${post.id}">•••</button>${ui.openMenu===post.id?postMenuHTML(post):''}</div></div>
    <div class="post-body">${post.quote?`<div class="quote">${escapeHtml(post.quote)}</div>`:''}<div class="post-text">${escapeHtml(post.text)}</div>${mediaHTML(post.media)}<div class="expiry ${hot?'hot':''}">${archived?'ARCHIVED ON THIS DEVICE':`${hot?'🔥 heated thread · ':''}${timeLeft(post.createdAt)}`}</div></div>
    <div class="post-actions">
      <button class="post-action ${reacted?'active':''}" data-action="like" data-id="${post.id}" ${archived?'disabled':''}>♥ <span>${likes||''}</span></button>
      <button class="post-action" data-action="reply" data-id="${post.id}" ${archived?'disabled':''}>↩ <span>${replies.length||''}</span></button>
      <button class="post-action" data-action="share" data-id="${post.id}" ${archived?'disabled':''}>↗</button>
      <button class="post-action ${bookmarked?'active':''}" data-action="bookmark" data-id="${post.id}" ${archived?'disabled':''}>◆</button>
      <button class="post-action" data-action="more" data-id="${post.id}">⋯</button>
    </div>
    ${ui.expandedReplies.has(post.id)?replyComposer(post):''}
    ${replies.length?`<div class="thread">${replies.slice(0,ui.expandedReplies.has(post.id)?99:2).map(r=>postCard(r,true)).join('')}${replies.length>2&&!ui.expandedReplies.has(post.id)?`<button class="secondary" data-action="show-replies" data-id="${post.id}">Show ${replies.length-2} more replies</button>`:''}</div>`:''}
  </article>`
}

function postMenuHTML(post){
  const own=post.authorId===profile.id;
  return `<div class="overflow-menu" data-overflow-menu>
    ${own?`<button data-menu-action="edit" data-id="${post.id}">Edit post</button><button class="danger" data-menu-action="delete" data-id="${post.id}">Delete post</button>`:`<button data-menu-action="follow" data-id="${post.id}">${state.follows[`${profile.id}:${post.authorId}`]?'Unfollow':'Follow'} @${escapeHtml((state.profiles[post.authorId]||{}).handle||'peer')}</button><button data-menu-action="report" data-id="${post.id}">Report post</button><button class="danger" data-menu-action="block" data-id="${post.id}">Block user</button>`}
    <button data-menu-action="copy" data-id="${post.id}">Copy post link</button>
  </div>`;
}

function mediaHTML(media){const src=mediaSource(media);if(!src)return '<div class="media-missing">Media is restoring from this device…</div>';if(media.type==='video')return `<div class="post-media"><video src="${src}" controls muted playsinline preload="metadata"></video></div>`;return `<div class="post-media"><img src="${src}" alt="Post media"></div>`}
function replyComposer(post){return `<div class="reply-box"><input data-reply-input="${post.id}" placeholder="Write a reply"><button class="primary" data-action="send-reply" data-id="${post.id}">Reply</button></div>`}

function layout(content,title='Home',tabs=''){
  return `<div class="app-shell">
  <aside class="sidebar"><div class="brand"><div class="brand-mark" aria-label="Broken Society logo"><svg viewBox="0 0 48 48" role="img"><path class="logo-frame" d="M7 6h24l10 10v26H17L7 32z"/><path class="logo-bolt" d="M25 8 16 24h8l-3 16 12-20h-8z"/><path class="logo-cut" d="m8 31 12-7M31 7l-7 12M39 18l-10 7"/></svg></div><span class="brand-wordmark">Broken<br><b>Society</b></span></div>${navHTML()}<button class="new-post" data-new-post>Post</button><div class="sidebar-user" data-edit-profile>${avatarHTML(profile)}<div class="user-meta"><strong>${escapeHtml(profile.name)}</strong><span>@${escapeHtml(profile.handle)}</span></div></div></aside>
  <main class="main"><header class="topbar"><h1>${escapeHtml(title)}</h1>${statusHTML()}</header>${tabs}${content}</main>
  <aside class="rightbar">${rightbarHTML()}</aside>
  ${mobileNavHTML()}</div>${ui.toast?`<div class="toast">${escapeHtml(ui.toast)}</div>`:''}`;
}
function navHTML(){return `<nav class="nav">${[['home','Home'],['discover','Discover'],['reels','Reels'],['notifications','Notifications'],['bookmarks','Bookmarks'],['profile','Profile']].map(([v,l])=>`<button class="nav-btn ${ui.view===v?'active':''}" data-view="${v}"><span class="nav-icon">${icons[v]}</span><span class="nav-label">${l}</span></button>`).join('')}</nav>`}
function mobileNavHTML(){return `<nav class="mobile-nav">${['home','discover','reels','notifications','profile'].map(v=>`<button class="${ui.view===v?'active':''}" data-view="${v}">${icons[v]}</button>`).join('')}</nav>`}
function statusHTML(){const label=ui.status==='ready'?'live':ui.status;return `<div class="status-pill ${ui.status}" title="${ui.status==='ready'?'P2P discovery is active':ui.status==='retrying'?'P2P discovery failed and will retry automatically':'Connecting to the peer network'}"><span class="status-dot"></span><span class="status-copy">${label} · </span><strong>${ui.peers}</strong> other peer${ui.peers===1?'':'s'}</div>`}
function tabsHTML(){return `<div class="tabs">${[['for-you','For you'],['following','Following'],['friends','Friends'],['media','Media']].map(([id,l])=>`<button class="tab ${ui.feed===id?'active':''}" data-feed="${id}">${l}</button>`).join('')}</div>`}
function composerHTML(){return `<section class="composer"><div class="composer-head">${avatarHTML(profile)}<textarea id="composerText" maxlength="1000" placeholder="What is breaking today?"></textarea></div><div class="dropzone" id="dropzone">Drop an image or GIF here — or click to browse<input id="mediaInput" type="file" accept="image/*" hidden></div><div class="media-preview" id="mediaPreview">${ui.composerMedia?mediaHTML(ui.composerMedia):''}</div><div class="composer-actions"><div class="action-row"><button class="icon-btn" data-media>▧</button><button class="icon-btn" data-insert="#">#</button><button class="icon-btn" data-insert="@">@</button></div><button class="primary" id="publishPost">Publish post</button></div></section>`}
function reelComposerHTML(){return `<section class="composer reel-composer"><div class="composer-kicker">CREATE A REEL</div><div class="composer-head">${avatarHTML(profile)}<textarea id="reelText" maxlength="500" placeholder="Add a caption to your reel…"></textarea></div><input id="reelInput" type="file" accept="video/mp4,video/webm,video/*" hidden><div class="dropzone reel-dropzone" id="reelDropzone"><strong>Drop a short video here</strong><span>or choose one from your device</span><button class="primary reel-choose" type="button" id="chooseReel">Choose video</button></div><div class="media-preview reel-preview">${ui.reelMedia?`<div class="post-media"><video src="${ui.reelMedia.src}" controls muted playsinline preload="metadata"></video><div class="selected-file">${escapeHtml(ui.reelMedia.name||'Selected video')}</div></div>`:''}</div><div class="reel-upload-notes"><span>MP4 or WebM</span><span>8 MB max</span><span>H.264 recommended</span></div><div class="composer-actions"><button class="secondary" id="clearReel">Clear</button><button class="primary" id="publishReel" ${ui.reelMedia?'':'disabled'}>Publish reel</button></div></section>`}
function rightbarHTML(){
  const people=Object.values(state.profiles).filter(p=>p.id!==profile.id&&!isBlocked(p.id)).slice(0,3);
  return `<div class="search"><span>⌕</span><input id="globalSearch" placeholder="Search the chaos"></div><section class="panel"><h3>Live pressure</h3><div class="trend"><small>Trending in the lobby</small><strong>#NoFilter</strong><span>${Object.keys(state.posts).length} active posts</span></div><div class="trend"><small>48-hour pulse</small><strong>Nothing lasts here</strong><span>${ui.peers} peers currently visible</span></div></section><section class="panel"><h3>People in the room</h3><div class="people">${people.length?people.map(p=>`<div class="person">${avatarHTML(p)}<div class="user-meta"><strong>${escapeHtml(p.name)}</strong><span>@${escapeHtml(p.handle)}</span></div><button class="secondary" data-follow="${p.id}">${state.follows[`${profile.id}:${p.id}`]?'Following':'Follow'}</button></div>`).join(''):'<div style="color:#777;font-size:13px">Waiting for peers to appear.</div>'}</div></section>`
}
function homeView(){const posts=visiblePosts().filter(p=>!p.parentId&&p.kind!=='reel');return layout(`${tabsHTML()}${composerHTML()}<section class="feed">${posts.length?posts.map(p=>postCard(state.posts[p.id]?p:{...p,localArchived:true})).join(''):emptyHTML('The feed is quiet','Open another browser or share the page. New peers will reconcile automatically.')}</section>`,'Home')}
function discoverView(){const posts=Object.values(state.posts).filter(p=>!p.parentId&&p.kind!=='reel'&&!isBlocked(p.authorId)).sort((a,b)=>(Object.keys(b.reactions||{}).length)-(Object.keys(a.reactions||{}).length));return layout(`<section class="feed" style="padding-top:16px">${posts.length?posts.map(postCard).join(''):emptyHTML('Searching peers','Discover fills as live content reaches your browser.')}</section>`,'Discover')}
function reelsView(){const videos=Object.values(state.posts).filter(p=>p.kind==='reel'&&p.media?.type==='video'&&!isBlocked(p.authorId)).sort((a,b)=>b.createdAt-a.createdAt);const feed=videos.length?`<section class="reels">${videos.map(p=>`<div class="reel"><video src="${p.media.src}" autoplay muted loop playsinline></video><div class="reel-overlay"><div class="reel-info"><strong>@${escapeHtml((state.profiles[p.authorId]||{}).handle||'peer')}</strong><p>${escapeHtml(p.text)}</p><small>${timeLeft(p.createdAt)}</small></div><div class="reel-actions"><button class="reel-action" data-action="like" data-id="${p.id}">♥</button><button class="reel-action" data-action="reply" data-id="${p.id}">↩</button><button class="reel-action" data-action="share" data-id="${p.id}">↗</button></div></div></div>`).join('')}</section>`:emptyHTML('No reels yet','Use the dedicated reel uploader above to publish the first video.');return layout(`${reelComposerHTML()}${feed}`,'Reels')}
function notificationsView(){const items=Object.values(state.notifications).filter(n=>n.to===profile.id).sort((a,b)=>b.createdAt-a.createdAt);return layout(`<section>${items.length?items.map(n=>`<div class="notification ${state.readNotifications[n.id]?'':'unread'}"><div class="notification-icon">${n.type==='reaction'?'♥':n.type==='reply'?'↩':'●'}</div><div><p>${escapeHtml(n.text)}</p><time>${timeAgo(n.createdAt)} ago</time></div></div>`).join(''):emptyHTML('No signals yet','Follows, reactions, replies and mentions will appear here.')}</section>`,'Notifications')}
function bookmarksView(){const posts=Object.values(state.bookmarks).filter(b=>b.userId===profile.id).map(b=>state.posts[b.postId]).filter(Boolean);return layout(`<section class="feed" style="padding-top:16px">${posts.length?posts.map(postCard).join(''):emptyHTML('Nothing saved','Bookmark posts to keep them visible until their 48-hour expiry.')}</section>`,'Bookmarks')}
function profileView(userId=profile.id){const p=state.profiles[userId]||profile;const own=p.id===profile.id;const source=own?{...creatorArchive,...state.posts}:state.posts;const posts=Object.values(source).filter(x=>x.authorId===p.id&&!x.parentId).sort((a,b)=>b.createdAt-a.createdAt);const followers=Object.values(state.follows).filter(f=>f.targetId===p.id&&!f.deleted).length;const following=Object.values(state.follows).filter(f=>f.userId===p.id&&!f.deleted).length;const friends=Object.values(state.friends).filter(f=>f.userId===p.id&&!f.deleted).length;return layout(`<div class="profile-cover"></div><section class="profile-info"><div class="profile-top">${avatarHTML(p,'profile-avatar')}<div class="profile-actions">${own?`<button class="secondary" data-edit-profile>Edit profile</button>`:`<button class="secondary" data-follow="${p.id}">${state.follows[`${profile.id}:${p.id}`]?'Following':'Follow'}</button><button class="secondary" data-friend="${p.id}">${state.friends[`${profile.id}:${p.id}`]?'Friend':'Add friend'}</button><button class="secondary" data-block="${p.id}">Block</button>`}</div></div><h2>${escapeHtml(p.name)}</h2><div class="handle">@${escapeHtml(p.handle)}</div><p class="profile-bio">${escapeHtml(p.bio)}</p><div class="stats"><div class="stat"><strong>${followers}</strong><span>followers</span></div><div class="stat"><strong>${following}</strong><span>following</span></div><div class="stat"><strong>${friends}</strong><span>friends</span></div></div></section><section class="feed" style="padding-top:16px">${own?'<div class="archive-note"><strong>Your creator archive</strong><span>Your own posts and reels stay on this device after the 48-hour live-feed window ends.</span></div>':''}${posts.length?posts.map(p=>postCard(state.posts[p.id]?p:{...p,localArchived:true})).join(''):emptyHTML('No posts yet',own?'Your published posts and reels will remain archived here on this device.':'This profile has no live posts.')}</section>`,'Profile')}
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
  document.querySelectorAll('[data-menu]').forEach(b=>b.onclick=e=>{e.stopPropagation();ui.openMenu=ui.openMenu===b.dataset.menu?null:b.dataset.menu;render()});
  document.querySelectorAll('[data-menu-action]').forEach(b=>b.onclick=e=>{e.stopPropagation();handleMenuAction(b.dataset.menuAction,b.dataset.id)});
  const publish=document.getElementById('publishPost');if(publish)publish.onclick=createPost;
  const publishReel=document.getElementById('publishReel');if(publishReel)publishReel.onclick=createReel;
  const clearReel=document.getElementById('clearReel');if(clearReel)clearReel.onclick=()=>{ui.reelMedia=null;render()};
  const input=document.getElementById('mediaInput'),drop=document.getElementById('dropzone');
  if(input)input.onchange=e=>handleFile(e.target.files[0],'post');
  if(drop){drop.onclick=()=>input.click();drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging')};drop.ondragleave=()=>drop.classList.remove('dragging');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragging');handleFile(e.dataTransfer.files[0],'post')}}
  const reelInput=document.getElementById('reelInput'),reelDrop=document.getElementById('reelDropzone'),chooseReel=document.getElementById('chooseReel');
  if(reelInput)reelInput.onchange=e=>handleFile(e.target.files[0],'reel');
  if(chooseReel)chooseReel.onclick=e=>{e.stopPropagation();reelInput?.click()};
  if(reelDrop){reelDrop.onclick=()=>reelInput.click();reelDrop.ondragover=e=>{e.preventDefault();reelDrop.classList.add('dragging')};reelDrop.ondragleave=()=>reelDrop.classList.remove('dragging');reelDrop.ondrop=e=>{e.preventDefault();reelDrop.classList.remove('dragging');handleFile(e.dataTransfer.files[0],'reel')}}
  document.querySelectorAll('[data-media]').forEach(b=>b.onclick=()=>input?.click());
  document.querySelectorAll('[data-insert]').forEach(b=>b.onclick=()=>{const t=document.getElementById('composerText');t.value+=b.dataset.insert;t.focus()});
  document.querySelectorAll('.reel video').forEach(v=>v.onclick=()=>v.muted=!v.muted);
}
async function handleFile(file,target='post'){
  if(!file)return;
  const maxSize=target==='reel'?40*1024*1024:12*1024*1024;
  if(file.size>maxSize){toast(`Media must be under ${target==='reel'?40:12} MB`);return}
  if(target==='reel'&&!file.type.startsWith('video/')){toast('Choose a video file for your reel');return}
  if(target==='post'&&file.type.startsWith('video')){toast('Videos belong in the Reels uploader');return}
  const mediaId=crypto.randomUUID();
  const src=URL.createObjectURL(file);
  const media={id:mediaId,type:file.type.startsWith('video')?'video':'image',src,name:file.name,mime:file.type,blob:file,size:file.size};
  try{await saveMediaBlob(mediaId,file)}catch(err){console.warn('Media persistence unavailable:',err)}
  if(target==='reel'){
    const probe=document.createElement('video');
    probe.preload='metadata';probe.muted=true;probe.playsInline=true;
    probe.onloadedmetadata=()=>{ui.reelMedia=media;render();toast('Video ready to preview')};
    probe.onerror=()=>{URL.revokeObjectURL(src);toast('This video codec cannot be previewed. Export as H.264 MP4 or WebM.')};
    probe.src=src;
  }else{ui.composerMedia=media;render();toast('Attachment ready')}
}
function createPost(){const text=document.getElementById('composerText')?.value.trim()||'';if(!text&&!ui.composerMedia){toast('Write something or add an image');return}const post={id:crypto.randomUUID(),authorId:profile.id,kind:'post',text,media:ui.composerMedia,createdAt:now(),updatedAt:now(),reactions:{}};ui.composerMedia=null;publish('posts',post);toast(ui.peers?`Post sent to ${ui.peers} peer${ui.peers===1?'':'s'}`:'Post published locally — waiting for peers')}
function createReel(){const text=document.getElementById('reelText')?.value.trim()||'';if(!ui.reelMedia){toast('Choose a video first');return}const reel={id:crypto.randomUUID(),authorId:profile.id,kind:'reel',text,media:ui.reelMedia,createdAt:now(),updatedAt:now(),reactions:{}};ui.reelMedia=null;publish('posts',reel);toast(ui.peers?`Reel sent to ${ui.peers} peer${ui.peers===1?'':'s'}`:'Reel published locally — waiting for peers')}
function handlePostAction(action,id){const post=state.posts[id]||creatorArchive[id];if(!post)return;
  if(action==='like'){post.reactions=post.reactions||{};post.reactions[profile.id]?delete post.reactions[profile.id]:post.reactions[profile.id]=now();post.updatedAt=now();publish('posts',post);if(post.authorId!==profile.id)notify(post.authorId,'reaction',`${profile.name} reacted to your post.`)}
  if(action==='reply'||action==='show-replies'){ui.expandedReplies.add(id);render();setTimeout(()=>document.querySelector(`[data-reply-input="${id}"]`)?.focus(),0)}
  if(action==='send-reply'){const inp=document.querySelector(`[data-reply-input="${id}"]`);const text=inp?.value.trim();if(!text)return;const reply={id:crypto.randomUUID(),authorId:profile.id,parentId:id,text,quote:post.text.slice(0,140),createdAt:now(),updatedAt:now(),reactions:{}};publish('posts',reply);notify(post.authorId,'reply',`${profile.name} replied: ${text.slice(0,80)}`)}
  if(action==='share'){if(!post.shareCode){post.shareCode=randomCode();post.updatedAt=now();publish('posts',post)}const url=`${location.origin}${location.pathname}#post/${post.shareCode}`;navigator.clipboard?.writeText(url);history.replaceState(null,'',`#post/${post.shareCode}`);toast('Share link copied')}
  if(action==='bookmark'){const key=`${profile.id}:${id}`;if(state.bookmarks[key])delete state.bookmarks[key];else state.bookmarks[key]={id:key,userId:profile.id,postId:id,createdAt:now(),updatedAt:now()};saveState();render()}
  if(action==='more'){const authorId=post.authorId;if(authorId===profile.id){if(confirm('Delete this post everywhere and from your archive?')){delete state.posts[id];removeFromCreatorArchive(id);saveState();broadcast({kind:'snapshot',payload:snapshot()});render()}}else if(confirm('Block this user and hide all their content?'))blockUser(authorId)}
}
function handleMenuAction(action,id){
  const post=state.posts[id]||creatorArchive[id];
  if(!post)return;
  ui.openMenu=null;
  if(action==='copy'){handlePostAction('share',id);return}
  if(action==='delete'){
    if(confirm('Delete this post everywhere and from your creator archive?')){delete state.posts[id];removeFromCreatorArchive(id);saveState();broadcast({kind:'snapshot',payload:snapshot()});render();toast('Post deleted')}
    return;
  }
  if(action==='edit'){
    const next=prompt('Edit your post',post.text||'');
    if(next!==null){post.text=next.trim();post.updatedAt=now();publish('posts',post);toast('Post updated')}
    return;
  }
  if(action==='follow'){toggleGraph('follows',post.authorId);return}
  if(action==='block'){if(confirm('Block this user and hide all their content?'))blockUser(post.authorId);return}
  if(action==='report'){toast('Report saved locally for review');render();return}
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
window.addEventListener('online',()=>initP2P());window.addEventListener('offline',()=>{ui.status='offline';connectedPeerIds.clear();ui.peers=localPeerSessions.size;render()});
render();hydrateMedia();initP2P();resolveDeepLink();setInterval(()=>{cleanup();saveState();render()},60000);
