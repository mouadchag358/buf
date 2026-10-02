# Planificateur Buffer

Ce dépôt envoie automatiquement les publications de `posts.json` vers les canaux Facebook et Instagram connectés à Buffer. Il n'héberge aucun serveur et ne contient plus de tableau de bord : GitHub Actions exécute la synchronisation toutes les six heures.

## Configuration GitHub

Dans le dépôt GitHub, ouvrez **Settings > Secrets and variables > Actions > New repository secret**, puis créez :

```text
BUFFER_API_KEY
```

La valeur doit être la clé API personnelle créée dans les réglages API Buffer. Ne placez jamais cette clé dans un fichier suivi par Git.

Le workflow utilise les canaux suivants :

- Facebook : `6ab674f7ea19ca0bdee54b05`
- Instagram : `6ab6749aea19ca0bdee546fa`
- Organisation : `6a9dd40e7a5c57f938ac3176`

## Fonctionnement

- `.github/workflows/buffer-sync.yml` lance la synchronisation toutes les six heures et peut aussi être déclenché manuellement depuis l'onglet **Actions**.
- Les images référencées par `posts.json` sont servies directement depuis `images/library` avec les URL publiques GitHub.
- Chaque exécution examine au maximum cinq nouvelles livraisons, tous canaux confondus (`BUFFER_MAX_ATTEMPTS`). Le budget est partagé entre les canaux actifs : avec cinq tentatives et deux canaux, Facebook en reçoit trois et Instagram deux. Un canal plein, en pause ou sans publication candidate ne réserve pas de tentatives. Une erreur de création Buffer arrête les envois pour cette exécution ; les quotas épuisés ne sont pas retentés.
- Le type `post` est transmis dans les métadonnées Facebook et Instagram, avec `shouldShareToFeed: true` pour Instagram. Seules les publications avec image sont prises en charge.
- Le workflow échoue en cas d’erreurs et sauvegarde quand même les envois déjà effectués pour éviter les doublons.
- Chaque canal conserve au maximum dix publications en attente dans Buffer.
- Après une synchronisation, le workflow valide dans Git les identifiants Buffer enregistrés dans `posts.json`. Cela empêche les doublons entre deux exécutions GitHub Actions.
- Une réponse incertaine de Buffer est bloquée et nécessite une vérification manuelle avant toute nouvelle tentative.

## Test local

Copiez `.env.example` vers `.env`, ajoutez la clé, puis exécutez :

```bash
npm ci
npm test
npm run buffer:dry-run
```

Le `dry-run` vérifie les canaux, les dates et l'accès aux images sans créer de publication. Pour synchroniser réellement :

```bash
npm run buffer:sync
```

## Format de `posts.json`

Chaque publication contient au minimum :

```json
{
  "id": "identifiant-unique",
  "text": "Légende",
  "image": "images/library/visuel.png",
  "scheduledAt": "2026-10-03T08:00:00.000Z"
}
```

`targetNetworks` peut limiter une publication à `facebook` ou `instagram`. Sans cette propriété, les deux réseaux sont utilisés.
