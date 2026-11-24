# Stockage privé des produits avec Cloudflare R2

V12 génère un lien de téléchargement signé uniquement après vérification d'un accès produit actif. Le lien est valable 60 secondes et les identifiants R2 restent côté serveur.

## Variables d'environnement Render

Ajouter comme secrets (ne jamais les mettre dans Git) :

- `R2_ACCOUNT_ID` : identifiant du compte Cloudflare
- `R2_ACCESS_KEY_ID` : Access Key ID du jeton R2
- `R2_SECRET_ACCESS_KEY` : Secret Access Key du jeton R2
- `R2_BUCKET` : nom du bucket privé

Créer un jeton R2 limité au bucket Fructy. La permission Object Read suffit aux téléchargements ; Object Read & Write sera nécessaire pour le futur flux d'upload administrateur.

## Associer un PDF à un produit

1. Déposer le PDF dans le bucket privé R2.
2. Copier sa clé d'objet exacte (ex. `products/guide-debutant.pdf`).
3. Renseigner cette clé dans le champ `fileKey` du produit depuis l'administration.
4. Publier le produit.

Ne pas rendre le bucket public et ne pas utiliser une URL publique comme `fileKey`.

## Sécurité

- `GET /api/products/:id/download` exige une session valide et un accès produit non expiré.
- Le serveur signe uniquement un GET pour l'objet enregistré en base.
- Le lien est un jeton temporaire : toute personne qui le reçoit peut l'utiliser pendant sa durée de validité.
- Sans les variables R2, le endpoint renvoie une erreur 503 et aucun téléchargement n'est simulé.

La configuration R2 et le dépôt réel des fichiers restent à effectuer dans Cloudflare et Render. Aucun secret ni bucket n'est créé automatiquement par ce code.
