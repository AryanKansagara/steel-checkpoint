/* Introduction only: no workspace creation or destination requests. */
(() => {
 const root=document.documentElement, key=root.dataset.themeKey;
 const media=window.matchMedia('(prefers-color-scheme: dark)');
 let preference='system';
 try{const value=localStorage.getItem(key);if(['light','dark'].includes(value))preference=value;}catch{}
 const apply=()=>{root.dataset.theme=preference==='system'?(media.matches?'dark':'light'):preference;};
 apply();media.addEventListener('change',apply);
 document.addEventListener('DOMContentLoaded',()=>{
  const control=document.querySelector('#appearance');control.value=preference;
  control.addEventListener('change',()=>{preference=control.value;try{if(preference==='system')localStorage.removeItem(key);else localStorage.setItem(key,preference);}catch{}apply();});
 });
 window.addEventListener('storage',event=>{if(event.key===key||event.key===null){try{const value=localStorage.getItem(key);preference=['light','dark'].includes(value)?value:'system';}catch{}apply();const control=document.querySelector('#appearance');if(control)control.value=preference;}});
 // Preserve existing StopLine bookmarks that previously opened a workspace view at /.
 if(root.dataset.product==='stopline'&&['#profile','#history','#compare'].includes(location.hash))location.replace('/app'+location.hash);
})();
