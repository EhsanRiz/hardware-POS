/* Live product-search demo.
 *
 * This is not a mockup. It runs the same normalisation and matching rules as
 * src/lib/search.ts in the POS itself — the offline path that a real till uses
 * when the connection is down. Anyone can verify the claim on the page by
 * typing into it, which is the point: a demo that fakes its results is worth
 * less than no demo.
 *
 * Keep in step with src/lib/search.ts and supabase/migrations/0010–0011.
 */
(function () {
  "use strict";

  var CATALOGUE = [
    { name: "Nail Concrete 2.5 x 50mm",         sku: "NCN-2550",      unit: "kg",  price: 68.0 },
    { name: "Nail Concrete 3.0 x 60mm",         sku: "NCN-3060",      unit: "kg",  price: 72.0 },
    { name: "Nail Wire Round 2.5 x 50mm",       sku: "NWR-2550",      unit: "kg",  price: 42.0 },
    { name: "Screw Chipboard 4.0 x 40mm (100)", sku: "SCR-CHIP-4X40", unit: "box", price: 68.0 },
    { name: "Anchor Bolt Sleeve M10 x 100mm",   sku: "ANC-M10",       unit: "ea",  price: 18.5 },
    { name: "Cement 42.5N 50kg",                sku: "CEM-425-50",    unit: "bag", price: 115.0, barcode: "6001234000015" },
    { name: "Chain 6mm Galvanised",             sku: "CHN-06",        unit: "m",   price: 35.0 },
    { name: "River Sand",                       sku: "SND-RIV",       unit: "m3",  price: 420.0 },
    { name: "Paint PVA White 20L Interior",     sku: "PVA-WHT-20",    unit: "ea",  price: 749.0 },
    { name: "Poly Pipe 20mm x 25m",             sku: "PPE-20",        unit: "roll", price: 289.0 },
    { name: "Twin & Earth 2.5mm 100m",          sku: "CBL-25-100",    unit: "roll", price: 1450.0 },
    { name: "Padlock 50mm Brass",               sku: "PDL-50",        unit: "ea",  price: 89.0 }
  ];

  // Mirrors normalize_search_text() in SQL and normalizeSearchText() in TS.
  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/(\d),(\d)/g, "$1.$2")
      .replace(/(\d)\s*[x*×]\s*(\d)/g, "$1 x $2")
      .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, "$1 $2")
      .replace(/[^a-z0-9. ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textFor(p) {
    return normalize(p.name + " " + p.sku + " " + (p.barcode || ""));
  }

  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i], best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function search(query) {
    var n = normalize(query);
    if (!n) return CATALOGUE.slice(0, 4);

    var toks = n.split(" ").filter(function (t) { return t && t !== "x"; });
    if (!toks.length) return CATALOGUE.slice(0, 4);

    // Pass 1: every word must be accounted for.
    var hits = CATALOGUE.filter(function (p) {
      var t = textFor(p);
      return toks.every(function (tok) { return t.indexOf(tok) !== -1; });
    });

    // Pass 2: only if the precise pass found nothing.
    if (!hits.length) {
      hits = CATALOGUE.filter(function (p) {
        var words = textFor(p).split(" ").filter(Boolean);
        return toks.every(function (tok) {
          var tol = tok.length < 4 ? 1 : 2;
          return words.some(function (w) { return editDistance(tok, w, tol) <= tol; });
        });
      });
    }

    return hits.sort(function (a, b) { return a.name.length - b.name.length; }).slice(0, 5);
  }

  var money = function (n) { return "R" + n.toFixed(2); };

  var input = document.getElementById("demo-q");
  var list = document.getElementById("demo-results");
  if (!input || !list) return;

  function render() {
    var rows = search(input.value);
    list.innerHTML = "";
    if (!rows.length) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Nothing matches “" + input.value + "”.";
      list.appendChild(li);
      return;
    }
    rows.forEach(function (p) {
      var li = document.createElement("li");
      var left = document.createElement("div");
      var nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = p.name;
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = p.sku + "  ·  per " + p.unit;
      left.appendChild(nm);
      left.appendChild(meta);
      var pr = document.createElement("div");
      pr.className = "pr";
      pr.textContent = money(p.price);
      li.appendChild(left);
      li.appendChild(pr);
      list.appendChild(li);
    });
  }

  input.addEventListener("input", render);

  Array.prototype.forEach.call(document.querySelectorAll("[data-try]"), function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-try");
      input.focus();
      render();
    });
  });

  render();

  // Header shadow on scroll, matching innovaearth.com.
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
