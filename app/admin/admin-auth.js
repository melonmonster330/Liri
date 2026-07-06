// ═══════════════════════════════════════════════════════════════════════════════
// Authentication
// ═══════════════════════════════════════════════════════════════════════════════

let pw = sessionStorage.getItem("liri_admin_pw") || "";

function showLogin(err) {
  document.getElementById("dash").style.display = "none";
  document.getElementById("login").style.display = "flex";
  document.getElementById("login-err").textContent = err || "";
  sessionStorage.removeItem("liri_admin_pw");
  pw = "";
}

async function tryLogin() {
  pw = document.getElementById("pw-input").value.trim();
  if (!pw) return;
  document.getElementById("login-btn").textContent = "Checking…";
  document.getElementById("login").style.display = "none";
  document.getElementById("dash").style.display = "block";
  await load();
  document.getElementById("login-btn").textContent = "Enter";
  if (document.getElementById("login").style.display === "none") {
    sessionStorage.setItem("liri_admin_pw", pw);
  }
}

function initAuthListeners() {
  document.getElementById("login-btn").addEventListener("click", tryLogin);
  document.getElementById("pw-input").addEventListener("keydown", e => { 
    if (e.key === "Enter") tryLogin(); 
  });
}
