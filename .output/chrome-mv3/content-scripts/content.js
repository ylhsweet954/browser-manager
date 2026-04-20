var content=(function(){var e=Object.defineProperty,t=(e,t)=>()=>(e&&(t=e(e=0)),t),n=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r};function r(e){return e}var i=n({});function a(e,t=k){let n=String(e||``).replace(/\s+/g,` `).trim();return n.length>t?n.slice(0,t)+`...`:n}function o(){let e=document.scrollingElement||document.documentElement||document.body,t=window.innerHeight||document.documentElement.clientHeight||0,n=window.innerWidth||document.documentElement.clientWidth||0,r=Math.max(e?.scrollHeight||0,document.documentElement?.scrollHeight||0,document.body?.scrollHeight||0),i=Math.max(e?.scrollWidth||0,document.documentElement?.scrollWidth||0,document.body?.scrollWidth||0),a=window.scrollY||e?.scrollTop||0,o=window.scrollX||e?.scrollLeft||0,s=Math.max(0,r-t),c=Math.max(0,i-n);return{url:document.URL,title:document.title,scrollX:o,scrollY:a,maxScrollX:c,maxScrollY:s,viewportWidth:n,viewportHeight:t,documentWidth:i,documentHeight:r,atTop:a<=0,atBottom:a>=s,atLeft:o<=0,atRight:o>=c}}function s(e){return a([e.innerText,e.textContent,e.getAttribute(`aria-label`),e.getAttribute(`title`),e.getAttribute(`placeholder`),e.getAttribute(`alt`),e.getAttribute(`value`)].filter(Boolean).join(` `),2e3).toLowerCase()}function c(e){let t=e.getBoundingClientRect(),n=window.getComputedStyle(e);return n.display===`none`||n.visibility===`hidden`||Number(n.opacity)===0?!1:t.width>0&&t.height>0}function l(e){return!!(e.matches(`a, button, input, select, textarea, summary, option, label`)||e.getAttribute(`role`)===`button`||typeof e.onclick==`function`)}function u(e){let t=[`id`,`class`,`name`,`type`,`role`,`href`,`src`,`placeholder`,`aria-label`,`for`,`value`],n={};for(let r of t){let t=e.getAttribute(r);t!=null&&t!==``&&(n[r]=a(t,300))}return n}function d(e){let t=e.getBoundingClientRect();return{x:Math.round(t.x),y:Math.round(t.y),width:Math.round(t.width),height:Math.round(t.height),top:Math.round(t.top),left:Math.round(t.left),right:Math.round(t.right),bottom:Math.round(t.bottom),pageX:Math.round(t.left+window.scrollX),pageY:Math.round(t.top+window.scrollY)}}function f(e,t){return{index:t,tagName:e.tagName.toLowerCase(),text:a(e.innerText||e.textContent||``),value:a(e.value||``,300),visible:c(e),clickable:l(e),attributes:u(e),rect:d(e)}}function p({selector:e,text:t,matchExact:n}){if(!e&&!t)return{error:`Please provide at least one locator: selector or text`};let r;try{r=e?Array.from(document.querySelectorAll(e)):Array.from(document.querySelectorAll(`body *`))}catch(e){return{error:`Invalid selector: ${e.message}`}}if(!t)return{elements:r};let i=String(t).trim().toLowerCase();return{elements:r.filter(e=>{let t=s(e);return n?t===i:t.includes(i)})}}function m(e){let{elements:t,error:n}=p(e);if(n)return{error:n};let r=Number.isInteger(e.index)?e.index:0;return r<0||r>=t.length?{error:t.length===0?`No matching element found`:`Element index out of range: ${r}. Available matches: ${t.length}`}:{element:t[r],index:r,totalMatches:t.length}}function h(){if(document.getElementById(j))return;let e=document.createElement(`style`);e.id=j,e.textContent=`
    @keyframes tab-manager-highlight-pulse {
      0%, 100% { opacity: 0.2; transform: scale(0.98); }
      50% { opacity: 1; transform: scale(1); }
    }
    #${M} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      border: 3px solid #ff5f2e;
      background: rgba(255, 95, 46, 0.12);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.08);
      border-radius: 10px;
      animation: tab-manager-highlight-pulse 0.3s ease-in-out 3;
    }
  `,document.documentElement.appendChild(e)}function g(){F&&=(clearTimeout(F),null),document.getElementById(M)?.remove()}function _(){if(document.getElementById(N))return;let e=document.createElement(`style`);e.id=N,e.textContent=`
    #${P} {
      position: fixed;
      top: 20px;
      right: 20px;
      width: min(380px, calc(100vw - 24px));
      z-index: 2147483647;
      background: #fffdf5;
      border: 2px solid #111827;
      border-radius: 14px;
      box-shadow: 8px 8px 0 rgba(17, 24, 39, 0.16);
      color: #111827;
      font-family: ui-sans-serif, system-ui, sans-serif;
      overflow: hidden;
    }
    #${P} * {
      box-sizing: border-box;
    }
    #${P} .tm-reuse-header {
      padding: 14px 16px 10px;
      background: linear-gradient(135deg, #fde68a 0%, #fef3c7 100%);
      border-bottom: 1px solid #f59e0b;
      font-weight: 700;
      font-size: 14px;
    }
    #${P} .tm-reuse-body {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 13px;
      line-height: 1.5;
    }
    #${P} .tm-reuse-card {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #ffffff;
    }
    #${P} .tm-reuse-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #92400e;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    #${P} .tm-reuse-title {
      font-weight: 600;
      word-break: break-word;
    }
    #${P} .tm-reuse-url {
      margin-top: 4px;
      color: #6b7280;
      word-break: break-all;
      font-size: 12px;
    }
    #${P} .tm-reuse-domain {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 4px 8px;
      border-radius: 999px;
      background: #fffbeb;
      border: 1px solid #fcd34d;
      font-size: 12px;
      color: #92400e;
      font-weight: 600;
    }
    #${P} .tm-reuse-remember {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #374151;
      margin-top: 2px;
    }
    #${P} .tm-reuse-actions {
      display: flex;
      gap: 10px;
      margin-top: 4px;
    }
    #${P} button {
      appearance: none;
      border: 1px solid #111827;
      border-radius: 10px;
      padding: 10px 12px;
      min-height: 40px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }
    #${P} button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 0 rgba(17, 24, 39, 0.12);
    }
    #${P} .tm-reuse-btn-primary {
      flex: 1;
      background: #f59e0b;
      color: #111827;
    }
    #${P} .tm-reuse-btn-secondary {
      flex: 1;
      background: #ffffff;
      color: #111827;
    }
  `,document.documentElement.appendChild(e)}function v(){document.getElementById(P)?.remove()}function y(e,t,n){let r=document.createElement(`div`);r.className=`tm-reuse-card`;let i=document.createElement(`div`);i.className=`tm-reuse-label`,i.textContent=e;let o=document.createElement(`div`);o.className=`tm-reuse-title`,o.textContent=a(t||n||``,200);let s=document.createElement(`div`);return s.className=`tm-reuse-url`,s.textContent=a(n||``,500),r.append(i,o,s),r}function b(e,t){_(),v();let n=document.createElement(`div`);n.id=P;let r=document.createElement(`div`);r.className=`tm-reuse-header`,r.textContent=`检测到已打开的相同页面`;let i=document.createElement(`div`);i.className=`tm-reuse-body`;let a=document.createElement(`div`);a.textContent=`要复用这个历史 Tab 吗？如果不复用，我们会切回刚打开的新页面。`;let o=document.createElement(`div`);o.className=`tm-reuse-domain`,o.textContent=`域名：${e.domainKey||`未知`}`;let s=y(`已存在的页面`,e.existingTitle,e.existingUrl),c=y(`刚打开的新页面`,e.newTitle,e.newUrl),l=document.createElement(`label`);l.className=`tm-reuse-remember`;let u=document.createElement(`input`);u.type=`checkbox`;let d=document.createElement(`span`);d.textContent=`记住当前域名的选择`,l.append(u,d);let f=document.createElement(`div`);f.className=`tm-reuse-actions`;let p=document.createElement(`button`);p.type=`button`,p.className=`tm-reuse-btn-primary`,p.textContent=`复用历史 Tab`;let m=document.createElement(`button`);m.type=`button`,m.className=`tm-reuse-btn-secondary`,m.textContent=`不复用`;let h=t=>{chrome.runtime.sendMessage({type:`tab_reuse_prompt_decision`,decision:t,rememberChoice:u.checked,newTabId:e.newTabId,existingTabId:e.existingTabId,domainKey:e.domainKey||``},()=>{v()})};p.addEventListener(`click`,()=>h(`reuse`)),m.addEventListener(`click`,()=>h(`keep`)),f.append(p,m),i.append(a,o,s,c,l,f),n.append(r,i),document.documentElement.appendChild(n),t({success:!0})}function x(e,t){g(),h();let n=e.getBoundingClientRect(),r=document.createElement(`div`);r.id=M,r.style.top=`${Math.max(0,n.top-6)}px`,r.style.left=`${Math.max(0,n.left-6)}px`,r.style.width=`${Math.max(8,n.width+12)}px`,r.style.height=`${Math.max(8,n.height+12)}px`,document.documentElement.appendChild(r),F=window.setTimeout(()=>{r.remove(),F=null},t)}function S(e,t){let n=e.tagName.toLowerCase(),r=String(t??``),i=null;n===`input`?i=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,`value`)?.set:n===`textarea`?i=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,`value`)?.set:n===`select`&&(i=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,`value`)?.set),i?i.call(e,r):e.value=r,e.dispatchEvent(new Event(`input`,{bubbles:!0})),e.dispatchEvent(new Event(`change`,{bubbles:!0}))}function C(e){let t=Math.min(20,Math.max(1,Number.isInteger(e.maxResults)?e.maxResults:5)),{elements:n,error:r}=p(e);return r?{error:r}:{success:!0,selector:e.selector||null,text:e.text||null,count:n.length,truncated:n.length>t,matches:n.slice(0,t).map((e,t)=>f(e,t))}}function w(e){let t=m(e);if(t.error)return{error:t.error};let n=t.element;if(n.scrollIntoView({block:`center`,inline:`nearest`,behavior:`smooth`}),typeof n.focus==`function`)try{n.focus({preventScroll:!0})}catch{n.focus()}return n.click(),{success:!0,action:`click`,totalMatches:t.totalMatches,target:f(n,t.index)}}function T(e){let t=m(e);if(t.error)return{error:t.error};let n=t.element,r=n.tagName.toLowerCase();if(![`input`,`textarea`,`select`].includes(r))return{error:`Element is not a form field: <${r}>`};if(n.scrollIntoView({block:`center`,inline:`nearest`,behavior:`smooth`}),typeof n.focus==`function`)try{n.focus({preventScroll:!0})}catch{n.focus()}return S(n,e.value),{success:!0,action:`set_value`,totalMatches:t.totalMatches,value:a(n.value||``,500),target:f(n,t.index)}}function E(e){let t=m(e);if(t.error)return{error:t.error};if(!e.styles||typeof e.styles!=`object`||Array.isArray(e.styles))return{error:`Please provide a styles object`};let n=Math.min(1e4,Math.max(0,Number.isFinite(e.durationMs)?e.durationMs:2e3)),r=t.element,i={};r.scrollIntoView({block:`center`,inline:`nearest`,behavior:`smooth`});for(let[t,n]of Object.entries(e.styles))i[t]=r.style[t],r.style[t]=String(n);return n>0&&window.setTimeout(()=>{for(let[e,t]of Object.entries(i))r.style[e]=t},n),{success:!0,action:`style`,durationMs:n,styles:e.styles,target:f(r,t.index)}}function D(e){let t=m(e);if(t.error)return{error:t.error};let n=e.mode===`inner`?`inner`:`outer`,r=Math.min(2e4,Math.max(200,Number.isInteger(e.maxLength)?e.maxLength:A)),i=t.element,a=n===`inner`?i.innerHTML:i.outerHTML;return{success:!0,mode:n,truncated:a.length>r,html:a.length>r?a.slice(0,r)+`...`:a,target:f(i,t.index)}}function O(e,t){let n=m(e);if(n.error){t({error:n.error});return}let r=Math.min(5e3,Math.max(300,Number.isFinite(e.durationMs)?e.durationMs:1e3)),i=n.element;i.scrollIntoView({block:`center`,inline:`nearest`,behavior:`smooth`}),window.setTimeout(()=>{x(i,r),t({success:!0,action:`highlight`,durationMs:r,target:f(i,n.index),scroll:o()})},350)}var k,A,j,M,N,P,F,I=t((()=>{k=500,A=4e3,j=`__tab_manager_highlight_style__`,M=`__tab_manager_highlight_overlay__`,N=`__tab_manager_reuse_prompt_style__`,P=`__tab_manager_reuse_prompt__`,F=null,chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type===`tab_extract_content`)return n({url:document.URL,title:document.title,content:document.body.innerText.substring(0,8e3)}),!1;if(e.type===`tab_scroll`){let t=o(),r=e.behavior===`smooth`?`smooth`:`auto`,i=typeof e.position==`string`?e.position:null,a=null;a=i===`top`?0:i===`bottom`?t.maxScrollY:typeof e.deltaY==`number`&&Number.isFinite(e.deltaY)?t.scrollY+e.deltaY:typeof e.pageFraction==`number`&&Number.isFinite(e.pageFraction)?t.scrollY+t.viewportHeight*e.pageFraction:t.scrollY+t.viewportHeight*.8,a=Math.max(0,Math.min(t.maxScrollY,a)),window.scrollTo({top:a,behavior:r});let s=r===`smooth`?400:60;return window.setTimeout(()=>{let e=o();n({success:!0,action:i||`delta`,requestedTop:a,moved:Math.abs(e.scrollY-t.scrollY)>1,before:t,after:e})},s),!0}return e.type===`dom_query`?(n(C(e)),!1):e.type===`dom_click`?(n(w(e)),!1):e.type===`dom_set_value`?(n(T(e)),!1):e.type===`dom_style`?(n(E(e)),!1):e.type===`dom_get_html`?(n(D(e)),!1):e.type===`dom_highlight`?(O(e,n),!0):(e.type===`show_tab_reuse_prompt`&&b(e,n),!1)})})),L=r({matches:[`http://*/*`,`https://*/*`],runAt:`document_idle`,async main(){await Promise.resolve().then(()=>(I(),i))}}),R={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)},z=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,B=class e extends Event{static EVENT_NAME=V(`wxt:locationchange`);constructor(t,n){super(e.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}};function V(e){return`${z?.runtime?.id}:content:${e}`}var H=typeof globalThis.navigation?.addEventListener==`function`;function U(e){let t,n=!1;return{run(){n||(n=!0,t=new URL(location.href),H?globalThis.navigation.addEventListener(`navigate`,e=>{let n=new URL(e.destination.url);n.href!==t.href&&(window.dispatchEvent(new B(n,t)),t=n)},{signal:e.signal}):e.setInterval(()=>{let e=new URL(location.href);e.href!==t.href&&(window.dispatchEvent(new B(e,t)),t=e)},1e3))}}}var W=class e{static SCRIPT_STARTED_MESSAGE_TYPE=V(`wxt:content-script-started`);id;abortController;locationWatcher=U(this);constructor(e,t){this.contentScriptName=e,this.options=t,this.id=Math.random().toString(36).slice(2),this.abortController=new AbortController,this.stopOldScripts(),this.listenForNewerScripts()}get signal(){return this.abortController.signal}abort(e){return this.abortController.abort(e)}get isInvalid(){return z.runtime?.id??this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(e){return this.signal.addEventListener(`abort`,e),()=>this.signal.removeEventListener(`abort`,e)}block(){return new Promise(()=>{})}setInterval(e,t){let n=setInterval(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearInterval(n)),n}setTimeout(e,t){let n=setTimeout(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearTimeout(n)),n}requestAnimationFrame(e){let t=requestAnimationFrame((...t)=>{this.isValid&&e(...t)});return this.onInvalidated(()=>cancelAnimationFrame(t)),t}requestIdleCallback(e,t){let n=requestIdleCallback((...t)=>{this.signal.aborted||e(...t)},t);return this.onInvalidated(()=>cancelIdleCallback(n)),n}addEventListener(e,t,n,r){t===`wxt:locationchange`&&this.isValid&&this.locationWatcher.run(),e.addEventListener?.(t.startsWith(`wxt:`)?V(t):t,n,{...r,signal:this.signal})}notifyInvalidated(){this.abort(`Content script context invalidated`),R.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){document.dispatchEvent(new CustomEvent(e.SCRIPT_STARTED_MESSAGE_TYPE,{detail:{contentScriptName:this.contentScriptName,messageId:this.id}})),window.postMessage({type:e.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:this.id},`*`)}verifyScriptStartedEvent(e){let t=e.detail?.contentScriptName===this.contentScriptName,n=e.detail?.messageId===this.id;return t&&!n}listenForNewerScripts(){let t=e=>{!(e instanceof CustomEvent)||!this.verifyScriptStartedEvent(e)||this.notifyInvalidated()};document.addEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t),this.onInvalidated(()=>document.removeEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t))}},G={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)};return(async()=>{try{let{main:e,...t}=L;return await e(new W(`content`,t))}catch(e){throw G.error(`The content script "content" crashed on startup!`,e),e}})()})();
content;