const $ = (s) => document.querySelector(s);
let config = { taskRewardPhp: 3, minWithdrawalPhp: 50, referralBonusPhp: 0 };
let currentUser = null, currentTask = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function message(el, text, type = "") { el.textContent = text; el.className = `message ${type}`; }
function toast(text) { const el=$("#toast"); el.textContent=text; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2600); }
function pesos(amount) { return "₱" + Number(amount || 0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function setAuthTab(tab) {
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  $("#loginForm").classList.toggle("hidden",tab!=="login");
  $("#registerForm").classList.toggle("hidden",tab!=="register");
  message($("#authMessage"),"");
}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>setAuthTab(b.dataset.tab)));
document.querySelectorAll(".nav-tab").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));

async function refreshConfig() {
  try { config = await api("/api/config"); } catch {}
  $("#rewardChip").textContent = `₱${Number(config.taskRewardPhp).toFixed(2)} / reply`;
  $("#taskReward").textContent = `₱${Number(config.taskRewardPhp).toFixed(2)} / reply`;
  $("#minimumText").textContent = `Minimum withdrawal: ${pesos(config.minWithdrawalPhp)}`;
  $("#withdrawForm [name=amountPHP]").min = config.minWithdrawalPhp;
  $("#referralBonusText").textContent = `Referral rewards are currently disabled.`;
}
function showApp(user) {
  currentUser=user;
  $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden"); $("#logoutBtn").classList.remove("hidden");
  $("#userName").textContent=user.name; $("#adminNav").classList.toggle("hidden",user.role!=="admin");
  updateBalance(user); loadDashboard();
}
function updateBalance(user) {
  currentUser=user;
  $("#pointsBalance").textContent=pesos(user.balancePhp);
  $("#pesoBalance").textContent="Direct cash balance";
  $("#walletPoints").textContent=pesos(user.balancePhp);
  $("#walletPeso").textContent="Available balance";
  $("#userName").textContent=user.name;
}
function showPage(page) {
  document.querySelectorAll(".nav-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  document.querySelectorAll(".page").forEach(p=>p.classList.toggle("hidden",p.id!==`page-${page}`));
  if(page==="admin") loadAdmin();
}
async function loadDashboard() {
  try {
    const d=await api("/api/dashboard"); updateBalance(d.user);
    $("#referralCount").textContent=d.referrals;
    $("#referralCode").textContent=d.user.referralCode;
    const rows=d.transactions.map(t=>`<tr><td>${escapeHtml(t.description)}</td><td class="${Number(t.amount_php)>=0?"positive":"negative"}">${Number(t.amount_php)>0?"+":""}${pesos(t.amount_php)}</td><td>${new Date(t.created_at).toLocaleString()}</td></tr>`).join("");
    $("#transactionRows").innerHTML=rows||'<tr><td colspan="3">No transactions yet.</td></tr>';
  } catch(e){toast(e.message);}
}
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault(); message($("#authMessage"),"Signing in…");
  try{const d=await api("/api/login",{method:"POST",body:JSON.stringify(formData(e.currentTarget))});showApp(d.user);}
  catch(err){message($("#authMessage"),err.message,"error");}
});
$("#registerForm").addEventListener("submit",async e=>{
  e.preventDefault(); message($("#authMessage"),"Creating account…");
  try{const d=await api("/api/register",{method:"POST",body:JSON.stringify(formData(e.currentTarget))});showApp(d.user);}
  catch(err){message($("#authMessage"),err.message,"error");}
});
$("#logoutBtn").addEventListener("click",async()=>{await api("/api/logout",{method:"POST"});location.reload();});

$("#startTaskBtn").addEventListener("click",async()=>{
  $("#startTaskBtn").disabled=true; message($("#taskMessage"),"Preparing a task…");
  try{
    const d=await api("/api/tasks/new",{method:"POST",body:"{}"}); currentTask=d.task;
    $("#taskTitle").textContent=`${d.task.task_type.toUpperCase()} TASK`;
    $("#taskQuestion").textContent=d.task.question;
    $("#answerForm").classList.remove("hidden"); $("#taskAnswer").value=""; $("#taskAnswer").focus();
    $("#startTaskBtn").classList.add("hidden"); message($("#taskMessage"),"Task started. You have 5 minutes to answer.","success");
  }catch(e){
    message($("#taskMessage"),e.message,"error");
    $("#startTaskBtn").disabled=false;
  }
});
$("#answerForm").addEventListener("submit",async e=>{
  e.preventDefault();if(!currentTask)return;
  const button=e.currentTarget.querySelector("button");button.disabled=true;
  try{
    const d=await api(`/api/tasks/${currentTask.id}/answer`,{method:"POST",body:JSON.stringify({answer:$("#taskAnswer").value})});
    updateBalance(d.user);message($("#taskMessage"),`${d.message} +${pesos(d.earnedPhp)} earned.`,"success");
    currentTask=null;$("#answerForm").classList.add("hidden");$("#taskQuestion").textContent="Great work! You can start another task immediately.";
    $("#startTaskBtn").classList.remove("hidden");$("#startTaskBtn").disabled=false;$("#startTaskBtn").textContent="Start another task →";loadDashboard();
  }catch(err){message($("#taskMessage"),err.message,"error");}
  finally{button.disabled=false;}
});
$("#withdrawForm").addEventListener("submit",async e=>{
  e.preventDefault();message($("#withdrawMessage"),"Submitting request…");
  try{const d=await api("/api/withdrawals",{method:"POST",body:JSON.stringify(formData(e.currentTarget))});message($("#withdrawMessage"),d.message,"success");e.currentTarget.reset();loadDashboard();}
  catch(err){message($("#withdrawMessage"),err.message,"error");}
});
$("#copyReferral").addEventListener("click",async()=>{await navigator.clipboard.writeText($("#referralCode").textContent);toast("Referral code copied.");});

$("#codeForm").addEventListener("submit",async e=>{
  e.preventDefault();try{const d=await api("/api/admin/codes",{method:"POST",body:JSON.stringify(formData(e.currentTarget))});$("#generatedCodes").value=d.codes.join("\\n");toast("Activation codes generated.");}
  catch(err){toast(err.message);}
});
$("#copyCodes").addEventListener("click",async()=>{await navigator.clipboard.writeText($("#generatedCodes").value);toast("Codes copied.");});
async function loadAdmin(){
  try{
    const d=await api("/api/admin/overview");
    $("#adminUsers").innerHTML=d.users.map(u=>`<div class="admin-user"><div><b>${escapeHtml(u.display_name)}</b><small>${escapeHtml(u.email)} · ${pesos(u.balance_php)} ${u.is_banned?"· SUSPENDED":""}</small></div><button class="btn btn-outline mini-btn" data-user="${u.id}" data-action="${u.is_banned?"unban":"ban"}">${u.is_banned?"Unban":"Ban"}</button></div>`).join("")||"No members yet.";
    $("#adminUsers").querySelectorAll("button").forEach(b=>b.addEventListener("click",async()=>{try{await api(`/api/admin/users/${b.dataset.user}/${b.dataset.action}`,{method:"POST",body:JSON.stringify({reason:"Admin action"})});loadAdmin();}catch(e){toast(e.message);}}));
    $("#adminWithdrawalRows").innerHTML=d.withdrawals.map(w=>`<tr><td>${escapeHtml(w.email)}</td><td>${pesos(w.amount_php)}</td><td>${escapeHtml(w.method)}<br>${escapeHtml(w.account_name)}<br>${escapeHtml(w.account_number)}</td><td>${escapeHtml(w.status)}</td><td>${w.status==="pending"?`<div class="review-actions"><button class="btn btn-primary mini-btn" data-id="${w.id}" data-status="approved">Approve</button><button class="btn btn-outline mini-btn" data-id="${w.id}" data-status="rejected">Reject</button></div>`:"—"}</td></tr>`).join("")||'<tr><td colspan="5">No requests.</td></tr>';
    $("#adminWithdrawalRows").querySelectorAll("button").forEach(b=>b.addEventListener("click",async()=>{if(!confirm(`${b.dataset.status} withdrawal #${b.dataset.id}?`))return;try{await api(`/api/admin/withdrawals/${b.dataset.id}/review`,{method:"POST",body:JSON.stringify({status:b.dataset.status})});loadAdmin();}catch(e){toast(e.message);}}));
  }catch(e){toast(e.message);}
}
(async function init(){
  await refreshConfig();
  try{const d=await api("/api/me");showApp(d.user);}catch{setAuthTab("login");}
})();
