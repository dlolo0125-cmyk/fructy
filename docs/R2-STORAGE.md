# Stockage privé des produits avec Cloudflare R2

V12 génère un lien de téléchargement signé uniquement après vérification d'un accès produit actif. Le lien est valable 60 secondes et les identifiants R2 restent côté serveur.

## Variables d'environnement Render

Ajouter comme secrets (ne jamais les mettre dans Git) :

- `R2_ACCOUNT_ID` : identifiant du compte Cloudflare
- `R2_ACCESS_KEY_ID` : Access Key ID du jeton R2
- `R2_SECRET_ACCESS_KEY` : Secret Access Key du jeton R2
- `R2_BUCKET` : nom du bucket privé

Créer un jeton R2 limité au bucket Fructy. La permission Object Read & Write sur ce bucket est nécessaire pour les téléchargements et les envois administrateur.

## Configuration CORS du bucket

Dans Cloudflare R2, configure CORS sur le bucket privé pour autoriser l’origine exacte de ton application (par exemple `https://fructy.onrender.com`), la méthode `PUT`, l’en-tête `Content-Type` et l’en-tête de réponse `ETag`. N’autorise pas `*` en production. Si tu utilises un autre domaine, ajoute-le explicitement.

## Envoyer un PDF depuis l’administration

1. Ouvre `/admin` avec un compte administrateur.
2. Dans « Nouveau produit numérique », sélectionne un PDF de 25 Mo maximum.
3. L’interface vérifie l’extension, le type MIME et la signature `%PDF-`, puis demande au serveur un lien PUT signé de cinq minutes.
4. Le navigateur envoie directement le fichier au bucket privé. La clé générée est associée automatiquement au produit.
5. Crée le produit. Ne le publie qu'après avoir confirmé que l'envoi a réussi.

Le champ `fileKey` peut aussi être renseigné manuellement pour les objets déjà présents dans le bucket.

Ne pas rendre le bucket public et ne pas utiliser une URL publique comme `fileKey`.

## Sécurité

- `GET /api/products/:id/download` exige une session valide et un accès produit non expiré.
- Le serveur signe uniquement un GET pour l'objet enregistré en base.
- Le lien est un jeton temporaire : toute personne qui le reçoit peut l'utiliser pendant sa durée de validité.
- Sans les variables R2, le endpoint renvoie une erreur 503 et aucun téléchargement n'est simulé.

La configuration R2 et le dépôt réel des fichiers restent à effectuer dans Cloudflare et Render. Aucun secret ni bucket n'est créé automatiquement par ce code.
