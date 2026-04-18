;(function () {
  function getGameId() {
    try {
      var parts = location.pathname.split("/").filter(Boolean)
      // /games/<id>/index.html
      var i = parts.indexOf("games")
      if (i >= 0 && parts[i + 1]) return parts[i + 1]
    } catch {}
    return ""
  }

  function addStyle() {
    if (document.getElementById("publishEntryStyle")) return
    var s = document.createElement("style")
    s.id = "publishEntryStyle"
    s.textContent =
      ".publishEntry{position:absolute;top:12px;right:12px;z-index:40;display:flex;gap:8px}" +
      ".publishEntry a{padding:8px 12px;border-radius:999px;border:1px solid rgba(15,23,42,0.12);background:rgba(255,255,255,0.72);box-shadow:0 10px 22px rgba(2,6,23,0.06);font-size:13px;font-weight:900;text-decoration:none;color:rgba(15,23,42,0.85)}" +
      ".publishEntry a:hover{filter:brightness(1.02)}" +
      ".publishEntry a:active{transform:scale(0.99)}"
    document.head.appendChild(s)
  }

  async function run() {
    var gid = getGameId()
    if (!gid) return

    var me
    try {
      me = await fetch("/api/me", { cache: "no-store" }).then(function (r) {
        return r.json()
      })
    } catch {
      return
    }
    if (!me || !me.loggedIn) return

    var game = null
    try {
      var r = await fetch("/api/games/" + encodeURIComponent(gid), { cache: "no-store" })
      if (r.ok) {
        var j = await r.json()
        game = j && j.game
      }
    } catch {}

    var isAdmin = !!me.isAdmin
    var isAuthor = !!me.creatorId && game && game.creatorId === me.creatorId
    var can = isAdmin || isAuthor || (!game && !!me.creatorId)
    if (!can) return

    addStyle()
    var container = document.createElement("div")
    container.className = "publishEntry"
    var a = document.createElement("a")
    a.href = "/publish?id=" + encodeURIComponent(gid)
    a.textContent = game ? "更新" : "发布"
    container.appendChild(a)

    // 放到 card 右上角（避免被 header 的布局影响）
    var card = document.querySelector(".card")
    if (card) {
      card.style.position = "relative"
      card.appendChild(container)
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run)
  else run()
})()

