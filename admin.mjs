const form = document.querySelector("#login-form");
const password = document.querySelector("#password");
const error = document.querySelector("#error");
const params = new URLSearchParams(location.search);
const next = params.get("next");
const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/analytics.html";

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "请求失败");
  return payload;
}

request("/api/admin/session").then(session => {
  if (session.authenticated) location.replace(safeNext);
  if (!session.passwordConfigured) error.textContent = "服务端尚未配置 ADMIN_PASSWORD。";
}).catch(() => {});

form.addEventListener("submit", async event => {
  event.preventDefault();
  error.textContent = "";
  try {
    await request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value })
    });
    location.replace(safeNext);
  } catch (reason) {
    error.textContent = reason.message;
    password.select();
  }
});
