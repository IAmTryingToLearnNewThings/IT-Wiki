(function () {
  const form = document.querySelector(".site-search");
  if (!form) return;

  const input = form.querySelector('input[type="search"]');
  const resultsPanel = form.querySelector(".search-results");
  const resultsList = form.querySelector(".search-results-list");
  const status = form.querySelector(".search-results-status");
  const rootUrl = new URL("./", document.currentScript.src);

  let indexPromise;
  let searchNumber = 0;

  function normalize(value) {
    return value
      .toLocaleLowerCase("pl")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchScore(entry, query) {
    const title = normalize(entry.title);
    const context = normalize(entry.context);
    if (title === query) return 4;
    if (title.startsWith(query)) return 3;
    if (title.includes(query)) return 2;
    if (context.includes(query)) return 1;
    return 0;
  }

  function createPageEntries(pageUrl, html) {
    const page = new DOMParser().parseFromString(html, "text/html");
    const pageTitle = page.querySelector(".course-page h1, .course-page h2")?.textContent.trim() || page.title;
    const entries = [];
    const searchablePage = page.body.cloneNode(true);
    searchablePage.querySelectorAll("header, nav, aside, footer, script").forEach((element) => element.remove());

    function addEntry(title, context, href, kind, extraText) {
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle) return;

      const url = new URL(href, pageUrl);
      entries.push({
        title: cleanTitle,
        context,
        href: url.href,
        kind,
        searchableText: normalize(`${cleanTitle} ${context} ${extraText || ""}`),
      });
    }

    addEntry(pageTitle, "Dział", pageUrl.href, "DZIAŁ", searchablePage.textContent);

    page.querySelectorAll("h1[id], h2[id], h3[id]").forEach((heading) => {
      const title = heading.textContent.trim();
      if (title && title !== pageTitle) {
        const sectionText = heading.closest("article, section")?.textContent || "";
        addEntry(title, `${pageTitle} · Temat`, `${pageUrl.href}#${heading.id}`, "TEMAT", sectionText);
      }
    });

    page.querySelectorAll("article a, section a, .updates-list a").forEach((link) => {
      if (link.closest("nav, header, .sidebar, .breadcrumbs")) return;
      if (link.classList.contains("card-link")) return;

      const href = link.getAttribute("href");
      const title = link.querySelector(".update-title")?.textContent || link.textContent;
      if (!href || href.startsWith("#") || !title) return;

      const article = link.closest("article");
      const heading = article?.querySelector("h1, h2, h3");
      const updateType = link.querySelector(".update-type")?.textContent.trim();
      const context = heading
        ? `${pageTitle} · ${heading.textContent.trim()}`
        : updateType
          ? updateType
          : pageTitle;
      addEntry(title, context, href, "MATERIAŁ");
    });

    return entries;
  }

  async function loadPage(pageUrl) {
    const response = await fetch(pageUrl);
    if (!response.ok) {
      throw new Error(`Nie udało się wczytać ${pageUrl.pathname}: HTTP ${response.status}`);
    }

    const html = await response.text();
    const page = new DOMParser().parseFromString(html, "text/html");
    const linkedPages = [];

    page.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const linkedUrl = new URL(href, pageUrl);
      if (linkedUrl.origin !== rootUrl.origin || !/\.html$/i.test(linkedUrl.pathname)) return;

      linkedUrl.hash = "";
      linkedUrl.search = "";
      linkedPages.push(linkedUrl);
    });

    return { entries: createPageEntries(pageUrl, html), linkedPages };
  }

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = (async () => {
        const startUrl = new URL("index.html", rootUrl);
        const visited = new Set();
        const queued = new Set([startUrl.href]);
        let pending = [startUrl];
        let entries = [];

        while (pending.length) {
          const current = pending;
          pending = [];
          current.forEach((url) => visited.add(url.href));

          const loadedPages = await Promise.all(current.map(loadPage));
          loadedPages.forEach((loadedPage) => {
            entries = entries.concat(loadedPage.entries);
            loadedPage.linkedPages.forEach((url) => {
              if (!visited.has(url.href) && !queued.has(url.href)) {
                queued.add(url.href);
                pending.push(url);
              }
            });
          });
        }

        return entries;
      })();
    }

    return indexPromise;
  }

  function setOpen(open) {
    resultsPanel.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
  }

  function renderResults(entries) {
    resultsList.replaceChildren();

    if (!entries.length) {
      status.textContent = "Brak wyników. Spróbuj innego hasła.";
      return;
    }

    const visibleEntries = entries.slice(0, 8);
    status.textContent =
      entries.length > visibleEntries.length
        ? `Liczba wyników: ${entries.length}. Pokazano ${visibleEntries.length} pierwszych.`
        : `Liczba wyników: ${entries.length}.`;
    visibleEntries.forEach((entry) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const heading = document.createElement("strong");
      const context = document.createElement("span");
      const kind = document.createElement("span");

      heading.textContent = entry.title;
      context.textContent = entry.context;
      kind.className = "search-result-kind";
      kind.textContent = entry.kind;
      link.href = entry.href;
      link.append(kind, heading, context);

      if (new URL(entry.href).origin !== rootUrl.origin) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }

      link.addEventListener("click", () => setOpen(false));
      item.append(link);
      resultsList.append(item);
    });
  }

  async function search() {
    const requestNumber = ++searchNumber;
    const query = normalize(input.value);
    const terms = query.split(" ").filter(Boolean);

    if (!terms.length) {
      setOpen(false);
      resultsList.replaceChildren();
      status.textContent = "";
      return;
    }

    setOpen(true);
    status.textContent = "Wyszukiwanie...";
    resultsList.replaceChildren();

    try {
      const index = await loadIndex();
      if (requestNumber !== searchNumber) return;

      const matches = index
        .filter((entry) => terms.every((term) => entry.searchableText.includes(term)))
        .sort((a, b) => matchScore(b, query) - matchScore(a, query) || a.title.localeCompare(b.title, "pl"));

      renderResults(matches);
    } catch (error) {
      if (requestNumber !== searchNumber) return;
      console.error("Wyszukiwarka IT Wiki nie może wczytać materiałów.", error);
      status.textContent = "Nie udało się wczytać wyszukiwarki. Odśwież stronę, aby spróbować ponownie.";
      resultsList.replaceChildren();
    }
  }

  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      input.value = "";
      setOpen(false);
      input.focus();
    } else if (event.key === "ArrowDown") {
      resultsList.querySelector("a")?.focus();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    resultsList.querySelector("a")?.focus();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!form.contains(event.target)) setOpen(false);
  });

  form.hidden = false;
})();
