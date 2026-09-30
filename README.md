# Bot de publication pour une Page Facebook

## Instagram

Les publications en attente ciblent aussi Instagram lorsque son identifiant ou son jeton est renseigné. Les anciennes publications déjà terminées ne sont pas renvoyées. Le premier envoi enregistre les réseaux cibles ; retirer ensuite les paramètres Instagram ne supprime pas cette obligation sur les publications déjà commencées.

Ajoutez à `.env` :

```env
INSTAGRAM_ACCOUNT_ID=identifiant_professionnel
INSTAGRAM_ACCESS_TOKEN=jeton
INSTAGRAM_LOGIN_MODE=facebook
INSTAGRAM_MEDIA_BASE_URL=https://votre-domaine/media/instagram
```

Utilisez `facebook` pour Facebook Login (permissions `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`) ou `instagram` pour Instagram Login (`instagram_business_basic`, `instagram_business_content_publish`), avec le compte et le jeton correspondants. La présence de ces valeurs ne valide pas les permissions du jeton.

Lancez `node prepare-instagram.js` pour convertir les images en JPEG carrés 1080 × 1080 avec marges blanches, sans recadrage. Le dossier `images/instagram` doit être accessible en HTTPS sans authentification à l'URL `INSTAGRAM_MEDIA_BASE_URL`. Vous pouvez héberger ce dossier seul sur un stockage public ; ne mettez jamais `.env` en ligne. Les nouvelles images devront aussi être copiées sur ce stockage après conversion. Si l'application est hébergée, sa route `/media/instagram` sert directement ces fichiers. Une adresse localhost ne convient pas. Aucun hébergement n'est créé automatiquement.

Chaque réseau conserve sa réussite séparément. Si Instagram échoue après une réussite Facebook, la reprise ignore Facebook. Les conteneurs Instagram sont conservés pour vérifier leur état après une interruption. Un envoi dont le résultat reste incertain exige une vérification manuelle ; le bouton Débloquer ne supprime pas les preuves de réussite ou d'incertitude. En cas d'échec explicite, les publications datées sont retentées par le planificateur.

Le tableau de bord distingue la configuration Instagram et le résultat de chaque réseau. Les légendes Instagram sont limitées à 2 200 caractères. Les tests utilisent des réponses simulées et ne publient rien. Documentation : https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing

## Buffer

Le projet peut aussi transférer les publications en attente vers les files Facebook et Instagram de Buffer. Créez une clé API personnelle dans Buffer, puis renseignez au minimum :

```env
BUFFER_API_KEY=votre_cle
BUFFER_FACEBOOK_CHANNEL_ID=identifiant_du_canal_facebook
BUFFER_INSTAGRAM_CHANNEL_ID=identifiant_du_canal_instagram
PUBLIC_MEDIA_REPOSITORY=proprietaire/depot-public
PUBLIC_MEDIA_REF=main
```

Les images locales doivent être accessibles publiquement par Buffer. `PUBLIC_MEDIA_REPOSITORY` désigne donc le dépôt GitHub public contenant ce projet ; les chemins d'images sont transformés en URL `raw.githubusercontent.com`. Une image déjà définie avec une URL HTTPS est utilisée telle quelle. Ne publiez jamais `.env` ni votre clé API dans ce dépôt.

Si votre compte Buffer contient plusieurs organisations, ajoutez `BUFFER_ORGANIZATION_ID`. Pour sélectionner plusieurs canaux explicitement, utilisez `BUFFER_CHANNEL_IDS=id1,id2`; sinon les variables par réseau ci-dessus évitent d'envoyer par erreur vers un autre canal connecté.

Vérifiez le transfert sans créer de publication, puis lancez-le :

```bash
npm run buffer:dry-run
npm run buffer:sync
```

La commande est ponctuelle. Exécutez-la avec votre planificateur de tâches à la fréquence voulue. Elle limite par défaut chaque canal à dix publications Buffer en attente (`BUFFER_MAX_SCHEDULED=10`), respecte les limites quotidiennes signalées par Buffer, réconcilie les identifiants distants et bloque toute nouvelle tentative dont le résultat précédent est incertain.

Ce projet propose un **tableau de bord local** pour préparer, ordonner et publier des photos avec leur légende sur une Page Facebook. Le prochain contenu en attente est publié automatiquement chaque jour à 9 h et à 13 h (heure de Casablanca), via la Meta Graph API officielle.

Il ne fonctionne pas avec un profil Facebook personnel. Vous devez posséder ou administrer une **Page Facebook** et avoir le droit de créer du contenu sur cette Page.

## 1. Prérequis

- Node.js 20 ou une version plus récente ;
- une Page Facebook ;
- un compte Meta for Developers ;
- une application Meta ;
- un jeton d'accès de Page avec les permissions nécessaires ;
- des images JPEG, PNG, GIF, BMP ou TIFF de moins de 10 Mo.

Téléchargez la version LTS de Node.js sur <https://nodejs.org/>, installez-la, puis vérifiez l'installation :

```bash
node --version
npm --version
```

## 2. Installer le projet

Ouvrez un terminal dans le dossier `facebook-bot`, puis lancez :

```bash
npm install
```

Les modules `axios`, `dotenv`, `form-data` et `node-cron` seront installés dans `node_modules`.

## 3. Créer l'application Meta

1. Ouvrez <https://developers.facebook.com/apps/>.
2. Cliquez sur **Créer une application**.
3. Choisissez le cas d'utilisation permettant de gérer une Page Facebook, ou le type **Business** si cette option est proposée.
4. Associez l'application à votre portefeuille Business si Meta le demande.
5. Ajoutez le produit **Facebook Login for Business** ou la configuration Pages proposée par le tableau de bord.

Les libellés du tableau de bord peuvent évoluer. Consultez la documentation officielle :

- Pages API : <https://developers.facebook.com/docs/pages-api/>
- Référence Page Photos : <https://developers.facebook.com/docs/graph-api/reference/page/photos/>
- Jetons d'accès : <https://developers.facebook.com/docs/facebook-login/guides/access-tokens/>

## 4. Permissions nécessaires

Demandez au minimum ces permissions lors de la création du jeton utilisateur :

- `pages_show_list` : voir les Pages que vous gérez ;
- `pages_read_engagement` : accès requis par l'API Pages ;
- `pages_manage_posts` : créer et gérer les publications de la Page.

Le compte Facebook qui autorise l'application doit disposer de la tâche Page **CREATE_CONTENT** (création de contenu) ou d'un niveau d'accès équivalent.

Pour votre propre Page, les tests sont généralement possibles tant que votre compte possède un rôle dans l'application. Pour connecter les Pages d'autres utilisateurs, Meta peut exiger l'accès avancé, l'App Review, la vérification de l'entreprise et le passage de l'application en mode Live.

## 5. Récupérer le PAGE_ID et le Page Access Token

1. Ouvrez le Graph API Explorer : <https://developers.facebook.com/tools/explorer/>.
2. Sélectionnez votre application Meta.
3. Générez un **User Access Token** avec `pages_show_list`, `pages_read_engagement` et `pages_manage_posts`.
4. Acceptez l'accès à la Page concernée.
5. Effectuez cette requête dans l'explorateur :

```text
GET /me/accounts?fields=name,id,access_token,tasks
```

6. Dans la Page souhaitée :
   - copiez `id` : c'est votre `PAGE_ID` ;
   - copiez `access_token` : c'est votre **Page Access Token**.

N'utilisez pas le jeton utilisateur affiché en haut de l'explorateur à la place du jeton de Page retourné par `/me/accounts`.

Les jetons peuvent expirer ou être invalidés après un changement de mot de passe, de rôle ou de sécurité. Pour une utilisation durable, créez d'abord un jeton utilisateur longue durée, puis appelez de nouveau `/me/accounts` afin d'obtenir le jeton de Page correspondant. Vérifiez toujours le type, les permissions et l'expiration dans l'outil officiel : <https://developers.facebook.com/tools/debug/accesstoken/>.

## 6. Remplir le fichier .env

Ouvrez `.env` et ajoutez vos valeurs sans guillemets :

```env
PAGE_ID=123456789012345
PAGE_ACCESS_TOKEN=EAAB...
```

Ne publiez jamais ce fichier. `.gitignore` exclut déjà `.env` et `node_modules/`.

## 7. Ajouter les images

Placez vos véritables fichiers dans `images/` avec les noms indiqués dans `posts.json` :

```text
images/miel1.jpg
images/daghmous.jpg
```

Vous pouvez remplacer les images présentes ou en importer de nouvelles depuis le tableau de bord.

## 8. Ajouter ou modifier des publications

Chaque entrée de `posts.json` doit avoir un identifiant unique, un texte, un chemin d'image et `published: false` :

```json
{
  "id": 3,
  "text": "Votre nouvelle légende",
  "image": "images/nouvelle-image.jpg",
  "published": false
}
```

Le programme choisit le premier élément dont `published` vaut `false`. Après une réussite, il ajoute notamment :

- `published: true` ;
- `publishedAt` ;
- `facebookPostId` ;
- `facebookPhotoId`.

Ne remettez pas `published` à `false` sur une ancienne entrée, sauf si vous voulez réellement la republier.

## 9. Ouvrir le tableau de bord

Lancez l'application :

```bash
npm start
```

Ouvrez ensuite <http://127.0.0.1:3000> dans votre navigateur. Depuis l'interface, vous pouvez :

- parcourir les visuels importés dans la bibliothèque d'accès rapide ;
- générer plusieurs propositions de légende en arabe adaptées au produit, au prix et au pack affichés ;
- ajouter une image et une légende ;
- choisir une date et une heure propres à chaque publication ;
- modifier, supprimer et réordonner les publications ;
- filtrer les publications en attente, publiées ou en erreur ;
- effectuer une publication immédiate après confirmation ;
- débloquer manuellement une publication interrompue ;
- consulter l'état de la configuration et du planificateur.

Le tableau de bord écoute uniquement sur `127.0.0.1` par défaut. Ne configurez pas `HOST=0.0.0.0` sur une machine accessible depuis Internet sans ajouter une authentification et un proxy HTTPS.

## 10. Publier immédiatement en ligne de commande

Cette commande n'attend pas le prochain créneau. Elle publie immédiatement le prochain post non publié :

```bash
node scheduler.js --test
```

Vous pouvez aussi utiliser :

```bash
npm run post:now
```

Attention : le mode `--test` effectue une vraie publication Facebook. Il désactive seulement l'attente du planificateur.

## 11. Lancer uniquement le planificateur

```bash
npm run start:scheduler
```

Laissez le terminal et l'ordinateur ou le serveur allumés. Le processus doit rester actif pour publier à l'heure prévue.

Le tableau de bord lancé avec `npm start` démarre déjà le planificateur : ne lancez pas les deux commandes simultanément.

## 12. Changer l'heure et les réglages

Ajoutez les réglages souhaités dans `.env` :

```env
CRON_SCHEDULE=0 9,13 * * *
TIME_ZONE=Africa/Casablanca
PORT=3000
```

Exemples :

```env
CRON_SCHEDULE=30 8 * * *
CRON_SCHEDULE=0 18 * * *
```

Le fuseau utilisé est `Africa/Casablanca`.

## 13. Tests automatisés

Les tests n'appellent ni Meta ni Buffer :

```bash
npm test
```

## 14. Gestion des erreurs et des doublons

- Une image absente ou une configuration manquante produit un message clair.
- Une erreur Meta est affichée et enregistrée dans l'entrée avec `lastError` et `lastErrorAt`.
- Le bot reste actif après l'échec d'une publication planifiée.
- Une publication réussie passe à `published: true` et ne sera plus sélectionnée.
- `publishing: true` est enregistré avant l'appel réseau afin de limiter les doubles envois lors d'exécutions simultanées.

Aucun système externe ne peut garantir une idempotence absolue si Facebook publie le contenu mais que la connexion est interrompue avant la réception de sa réponse. Dans ce cas rare, vérifiez la Page et `posts.json` avant de relancer manuellement.

## 15. Erreurs fréquentes

- **OAuthException / code 190** : jeton invalide ou expiré.
- **Permissions error / code 200** : permission ou tâche Page manquante.
- **Image introuvable** : nom ou chemin incorrect dans `posts.json`.
- **Unsupported post request** : mauvais Page ID, mauvais type de jeton ou accès insuffisant.

Le jeton n'est jamais écrit dans les messages de console par ce projet.
#   b u f  
 