const state = { posts: [], library: [], filter: "all", configuration: null, scheduler: null, selectedAsset: null, captionVariant: 0 };
const postsContainer = document.querySelector("#posts");
const empty = document.querySelector("#empty");
const editor = document.querySelector("#editor");
const form = document.querySelector("#post-form");
const textInput = document.querySelector("#post-text");
const imageInput = document.querySelector("#post-image");
const preview = document.querySelector("#image-preview");
const dropCopy = document.querySelector("#drop-copy");
const toastElement = document.querySelector("#toast");

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Erreur HTTP ${response.status}`);
  return body;
}

function toast(message, error = false) {
  toastElement.textContent = message;
  toastElement.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastElement.className = "toast"; }, 3500);
}

function statusOf(post) {
  if (post.publishing) return ["publishing", "En cours"];
  if (post.published) return ["published", "Publiée"];
  if (post.lastError) return ["failed", "Erreur"];
  if (post.scheduledAt) return ["pending", "Programmée"];
  return ["pending", "À venir"];
}

function formatDate(value) {
  if (!value) return "Pas encore publiée";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function toLocalDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderStats() {
  const pending = state.posts.filter((post) => !post.published && !post.lastError).length;
  const published = state.posts.filter((post) => post.published).length;
  const failed = state.posts.filter((post) => post.lastError && !post.published).length;
  const schedule = state.scheduler ? `${state.scheduler.schedule} · ${state.scheduler.timeZone}` : "—";
  const cronParts = state.scheduler ? state.scheduler.schedule.trim().split(/\s+/) : [];
  const scheduleTime = cronParts.length === 5 && cronParts[0].match(/^\d+$/) && cronParts[1].match(/^\d+(,\d+)*$/)
    ? cronParts[1].split(",").map(hour => `${hour.padStart(2, "0")}:${cronParts[0].padStart(2, "0")}`).join(" · ")
    : "Actif";
  document.querySelector("#stats").innerHTML = `
    <div class="stat"><span>À venir</span><strong>${pending}</strong><small>publication${pending > 1 ? "s" : ""}</small></div>
    <div class="stat"><span>Publiées</span><strong>${published}</strong><small>au total</small></div>
    <div class="stat"><span>À vérifier</span><strong>${failed}</strong><small>erreur${failed > 1 ? "s" : ""}</small></div>
    <div class="stat"><span>Planification</span><strong>${scheduleTime}</strong><small>${schedule}</small></div>`;

  const connection = document.querySelector("#connection");
  connection.className = `connection ${state.configuration.facebookConfigured ? "ok" : "warning"}`;
  connection.innerHTML = `<span></span>${state.configuration.facebookConfigured ? "Facebook configuré" : "Configuration Facebook manquante"}`;
  const instagram = state.configuration.instagram;
  if (instagram?.enabled) {
    connection.append(document.createTextNode(instagram.credentialsPresent && instagram.mediaReady
      ? ' · Instagram configuré' : ' · Instagram : configuration à compléter'));
  }
}

function matchesFilter(post) {
  if (state.filter === "pending") return !post.published && !post.lastError;
  if (state.filter === "published") return post.published;
  if (state.filter === "failed") return Boolean(post.lastError && !post.published);
  return true;
}

function makeButton(label, className, action, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className || "";
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function renderPosts() {
  postsContainer.replaceChildren();
  const visible = state.posts.filter(matchesFilter);
  empty.hidden = visible.length > 0;

  visible.forEach((post) => {
    const [statusClass, statusLabel] = statusOf(post);
    const index = state.posts.findIndex((item) => String(item.id) === String(post.id));
    const article = document.createElement("article");
    article.className = "post-card";

    const image = document.createElement("img");
    image.className = "post-image";
    image.src = post.imageUrl;
    image.alt = "Visuel de la publication";
    article.append(image);

    const body = document.createElement("div");
    body.className = "post-body";
    const top = document.createElement("div");
    top.className = "post-top";
    const badge = document.createElement("span");
    badge.className = `badge ${statusClass}`;
    badge.textContent = statusLabel;
    const order = document.createElement("div");
    order.className = "order-controls";
    order.append(
      makeButton("↑", "", () => movePost(index, -1), index === 0),
      makeButton("↓", "", () => movePost(index, 1), index === state.posts.length - 1)
    );
    top.append(badge, order);

    const copy = document.createElement("p");
    copy.className = "post-text";
    copy.textContent = post.text;
    const date = document.createElement("p");
    date.className = "post-date";
    date.textContent = post.published
      ? `Publiée le ${formatDate(post.publishedAt)}`
      : (post.scheduledAt ? `Programmée le ${formatDate(post.scheduledAt)}` : `File quotidienne · créée ${formatDate(post.createdAt)}`);
    body.append(top, copy, date);
    const networks = document.createElement('p');
    networks.className = 'post-date';
    const targets = post.targetNetworks || (state.configuration.instagram?.enabled ? ['facebook', 'instagram'] : ['facebook']);
    networks.textContent = targets.map(network => {
      const sent = post.deliveries?.[network]?.status === 'published' || (network === 'facebook' && post.facebookPostId);
      return `${network === 'facebook' ? 'Facebook' : 'Instagram'} : ${sent ? 'publiée' : 'en attente'}`;
    }).join(' · ');
    body.append(networks);
    if (post.lastError && !post.published) {
      const error = document.createElement("div");
      error.className = "post-error";
      error.title = post.lastError;
      error.textContent = post.lastError;
      body.append(error);
    }

    const actions = document.createElement("div");
    actions.className = "post-actions";
    if (!post.published && !post.publishing) {
      actions.append(makeButton("Publier maintenant", "publish", () => publishPostNow(post)));
    }
    if (!post.publishing) actions.append(makeButton("Modifier", "", () => openEditor(post)));
    if (post.publishing) actions.append(makeButton("Débloquer", "", () => resetPost(post)));
    actions.append(makeButton("Supprimer", "remove", () => deletePost(post), post.publishing));
    body.append(actions);
    article.append(body);
    postsContainer.append(article);
  });
}

function generateCaption(asset) {
  const list = asset.details.map((detail) => `✓ ${detail}`).join("\n");
  const common = `\n💰 الثمن: ${asset.price}\n\n📞 للطلب: +212 766-577689\n📷 Instagram: @3sseltemara`;
  const variants = asset.kind === "pack" ? [
    `🍯 ${asset.title} من عسل تمارة\n\nتشكيلة مميزة لمحبي النكهات الأصيلة:\n${list}${common}`,
    `✨ عرض خاص: ${asset.title}\n\nكل ما تحتاجه لتجربة نكهات متنوعة في باقة واحدة:\n${list}${common}`,
    `🎁 اكتشفوا ${asset.title}\n\nباقة مختارة بعناية تضم:\n${list}${common}`
  ] : [
    `🍯 ${asset.title} من عسل تمارة\n\n${asset.details.join("، ")} ✨${common}`,
    `✨ مذاق يستحق التجربة\n\n${asset.title} — ${asset.details[0]}، ${asset.details[1]}.${common}`,
    `🐝 اختيار اليوم: ${asset.title}\n\nجودة مختارة ومذاق مميز لعشاق المنتجات الطبيعية.${common}`
  ];
  const caption = variants[state.captionVariant % variants.length];
  state.captionVariant += 1;
  return caption;
}

function renderLibrary() {
  const container = document.querySelector("#library");
  container.replaceChildren();
  state.library.forEach((asset) => {
    const card = document.createElement("article");
    card.className = "library-card";
    const image = document.createElement("img");
    image.src = asset.imageUrl;
    image.alt = asset.title;
    image.loading = "lazy";
    const body = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = asset.title;
    const subtitle = document.createElement("p");
    subtitle.textContent = `${asset.subtitle} · ${asset.price}`;
    const use = makeButton("Générer une légende", "", () => openEditor(null, asset));
    body.append(title, subtitle, use);
    card.append(image, body);
    container.append(card);
  });
}

async function refresh(silent = false) {
  try {
    const dashboard = await api("/api/dashboard");
    Object.assign(state, dashboard);
    renderStats();
    renderLibrary();
    renderPosts();
  } catch (error) {
    if (!silent) toast(error.message, true);
  }
}

function openEditor(post = null, asset = null) {
  form.reset();
  state.selectedAsset = asset;
  state.captionVariant = 0;
  preview.hidden = true;
  dropCopy.hidden = false;
  document.querySelector("#post-id").value = post ? post.id : "";
  document.querySelector("#library-image").value = asset ? asset.image : "";
  const scheduleInput = document.querySelector("#post-schedule");
  scheduleInput.value = post ? toLocalDateTimeInput(post.scheduledAt) : "";
  scheduleInput.disabled = Boolean(post && post.published);
  document.querySelector("#editor-title").textContent = post ? "Modifier la publication" : "Nouvelle publication";
  document.querySelector("#save-post").textContent = post ? "Enregistrer" : "Ajouter à la file";
  document.querySelector("#image-optional").textContent = post || asset ? "— remplacement facultatif" : "";
  imageInput.required = !post && !asset;
  textInput.value = post ? post.text : (asset ? generateCaption(asset) : "");
  const generateButton = document.querySelector("#generate-caption");
  generateButton.hidden = !asset;
  updateCharacterCount();
  if (post || asset) {
    preview.src = post ? post.imageUrl : asset.imageUrl;
    preview.hidden = false;
    dropCopy.hidden = true;
  }
  editor.showModal();
  textInput.focus();
}

function closeEditor() { editor.close(); }
function updateCharacterCount() {
  const count = textInput.value.length;
  document.querySelector("#character-count").textContent = `${count} caractère${count > 1 ? "s" : ""}`;
}

function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (state.configuration && file.size > state.configuration.maxImageBytes) return reject(new Error("L’image dépasse 10 Mo."));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).split(",")[1] });
    reader.onerror = () => reject(new Error("Impossible de lire l’image."));
    reader.readAsDataURL(file);
  });
}

async function submitPost(event) {
  event.preventDefault();
  const button = document.querySelector("#save-post");
  button.disabled = true;
  try {
    const id = document.querySelector("#post-id").value;
    const payload = {
      text: textInput.value,
      image: await fileToPayload(imageInput.files[0]),
      libraryImage: document.querySelector("#library-image").value || undefined,
      scheduledAt: document.querySelector("#post-schedule").value
        ? new Date(document.querySelector("#post-schedule").value).toISOString()
        : null
    };
    if (payload.image) delete payload.libraryImage;
    if (id && !payload.image) delete payload.image;
    await api(id ? `/api/posts/${encodeURIComponent(id)}` : "/api/posts", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    closeEditor();
    toast(id ? "Publication mise à jour." : "Publication ajoutée à la file.");
    await refresh(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function confirmAction(title, message, label) {
  const dialog = document.querySelector("#confirm-dialog");
  document.querySelector("#confirm-title").textContent = title;
  document.querySelector("#confirm-message").textContent = message;
  document.querySelector("#confirm-action").textContent = label;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

async function publishPostNow(post) {
  if (!await confirmAction("Publier maintenant ?", "Cette action enverra réellement l’image et sa légende sur votre Page Facebook.", "Publier")) return;
  toast("Publication en cours…");
  try {
    await api(`/api/posts/${encodeURIComponent(post.id)}/publish`, { method: "POST", body: "{}" });
    toast("Publication envoyée sur Facebook.");
  } catch (error) { toast(error.message, true); }
  await refresh(true);
}

async function resetPost(post) {
  if (!await confirmAction("Débloquer ce post ?", "Vérifiez d’abord votre Page : si Facebook l’a déjà reçu, une nouvelle tentative pourrait créer un doublon.", "Débloquer")) return;
  try {
    await api(`/api/posts/${encodeURIComponent(post.id)}/reset`, { method: "POST", body: "{}" });
    toast("Publication replacée dans la file.");
    await refresh(true);
  } catch (error) { toast(error.message, true); }
}

async function deletePost(post) {
  if (!await confirmAction("Supprimer cette publication ?", "Elle disparaîtra de la file. L’image restera conservée dans le dossier images.", "Supprimer")) return;
  try {
    await api(`/api/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
    toast("Publication supprimée.");
    await refresh(true);
  } catch (error) { toast(error.message, true); }
}

async function movePost(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.posts.length) return;
  [state.posts[index], state.posts[target]] = [state.posts[target], state.posts[index]];
  renderPosts();
  try {
    await api("/api/reorder", { method: "POST", body: JSON.stringify({ ids: state.posts.map((post) => post.id) }) });
  } catch (error) {
    toast(error.message, true);
    await refresh(true);
  }
}

document.querySelector("#open-create").addEventListener("click", () => openEditor());
document.querySelector("#close-editor").addEventListener("click", closeEditor);
document.querySelector("#cancel-editor").addEventListener("click", closeEditor);
form.addEventListener("submit", submitPost);
textInput.addEventListener("input", updateCharacterCount);
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) return;
  document.querySelector("#library-image").value = "";
  state.selectedAsset = null;
  document.querySelector("#generate-caption").hidden = true;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  dropCopy.hidden = true;
});
document.querySelector("#generate-caption").addEventListener("click", () => {
  if (!state.selectedAsset) return;
  textInput.value = generateCaption(state.selectedAsset);
  updateCharacterCount();
  toast("Nouvelle proposition générée.");
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.filter = button.dataset.filter;
  renderPosts();
}));

refresh();
setInterval(() => { if (!editor.open) refresh(true); }, 15000);
