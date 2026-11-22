# Fruty V9

**Nouveau départ :** cette livraison ne contient aucune donnée (pas de dossier `data/`, pas de `.env`). Au premier démarrage, une base vierge est créée : aucun ancien compte, seul l'administrateur défini par `ADMIN_PHONE` / `ADMIN_PASSWORD` existe. Copiez `.env.example` vers `.env` et renseignez vos clés (SasPay, etc.).

Cette version conserve l’architecture Node.js/SQLite et les fonctions de paiement existantes. Elle ajoute la migration 008 pour le versement des gains PDF à échéance, le suivi de progression dans Mes produits et une identité visuelle crypto modernisée.

## Ce qui change pour l'utilisateur
- **Gains PDF à échéance** : accumulation quotidienne après chaque période de 24 h, progression et compte à rebours dans Mes produits, puis versement unique du total au portefeuille de gains à l’expiration. Aucun gain PDF ne transite par le portefeuille d’achat.
- **Connexion crypto** : interface sombre modernisée avec accents violet/cyan et visuels de cryptomonnaies.
- **Premiers pas** : visite guidée de 4 écrans à la première connexion (rejouable dans Moi) et liste de progression sur l'accueil (activer, cadeau, question, première formation).
- **Confirmations claires** avant achat, VIP, retrait et déconnexion, avec le solde avant/après ; le solde insuffisant est détecté avant l'appel serveur avec un bouton « Déposer ».
- **Questions du jour** : options lisibles, retour visuel immédiat (vert/rouge), vibration, confettis, position de défilement conservée.
- **Dépôt / retrait** : montants rapides (jusqu'à 50 000 en dépôt, « Tout » en retrait), bouton « Payer 5 000 FCFA » dynamique, récapitulatif des gains restants, erreurs affichées pendant la saisie.
- **Confort** : masquer les soldes, thème clair/sombre, pastille « nouvelle annonce », bandeau hors ligne, boutons avec indicateur de chargement, force du mot de passe, envoi du code d'invitation par WhatsApp, indicateur de saisie dans l'assistant, installation sur l'écran d'accueil (manifest + icônes).
- **Administration** : pastilles de demandes en attente, filtre En attente / Historique, confirmation avant valider ou refuser, recherche de clients, fenêtres de saisie à la place des `prompt()`, notifications au lieu des `alert()`, chiffres clés par onglet, validation par code TOTP automatique à 6 chiffres.

Les sections ci-dessous (déploiement, paiements, sécurité) restent valables.

Application web Fruty : espace client, administration, catalogue PDF, gains PDF à échéance, quiz quotidiens et dépôts Chariow/SasPay. Cette livraison conserve l'architecture Node.js/SQLite et les interfaces existantes. La migration 004 ajoute le dépôt Chariow de 1 000 FCFA et conserve les commandes historiques.

## Dépôts Chariow — 1 000 à 20 000 FCFA

Le client doit d'abord activer son compte et compléter **Nom, prénom, email, moyen et numéro de paiement** dans Paramètres. Les montants proposés sont **1 000, 2 000, 5 000, 10 000 et 20 000 FCFA**. Le bouton correspondant crée le checkout côté serveur et préremplit les informations disponibles du profil. Le numéro T-Money/Flooz est transmis comme téléphone acheteur lorsque ce moyen est choisi. Chariow reste responsable de l'affichage des moyens de paiement réellement disponibles.

Le portefeuille d'achat n'est crédité qu'après réception d'un Pulse signé correspondant au produit, au montant sélectionné et à la devise `XOF`. Le traitement est idempotent : un même événement ne peut pas créditer deux fois. La redirection du navigateur ne crédite jamais le portefeuille.

**Produits Chariow configurés :**
- 1 000 F : `prd_qc1stvd5`
- 2 000 F : `prd_yl93dwer`
- 5 000 F : `prd_lie65vzx`
- 10 000 F : `prd_g00q5t16`
- 20 000 F : `prd_vw27ffj5`

Vérifier dans Chariow que chaque produit est publié et que son prix réel correspond exactement au montant annoncé en XOF. Le dépôt de 50 000 FCFA n'est pas encore proposé : son identifiant produit reste à fournir.

Après activation du compte, les informations du profil sont en lecture seule. Toute demande de correction doit être adressée à `sikaplus.con0125@gmail.com`.

## Installation Windows / test local

1. Installer Node.js 22.13 ou supérieur dans la branche 22.x.
2. Copier `.env.example` vers `.env`.
3. Renseigner `ADMIN_PHONE` et `ADMIN_PASSWORD` (10 caractères minimum) pour créer le premier administrateur.
4. Renseigner `CHARIOW_API_KEY` et `CHARIOW_PULSE_SECRET` uniquement si les paiements Chariow doivent être testés. Les dépôts actuellement disponibles sont de 1 000, 2 000, 5 000, 10 000 et 20 000 FCFA. Les identifiants des produits sont configurés par défaut dans `server.js` ; les variables `CHARIOW_PRODUCT_ID_2000`, `CHARIOW_PRODUCT_ID_5000`, `CHARIOW_PRODUCT_ID_10000` et `CHARIOW_PRODUCT_ID_20000` peuvent les remplacer si nécessaire. Le montant de 50 000 FCFA reste masqué jusqu'à la création et la configuration de son produit Chariow.
5. Lancer `npm start`, puis ouvrir `http://localhost:3000/` et `http://localhost:3000/gestion`.

Les migrations sont exécutées au démarrage. Une sauvegarde SQLite est créée avant chaque migration. Ne pas supprimer le dossier `data` d'une installation existante.

## Déploiement Render

Le dépôt contient `render.yaml` : il configure un service Node dans la région Virginia, Node 22.22.0, les commandes de build/démarrage et un disque persistant monté sur `/var/data`. La base SQLite, la clé secrète et les PDF privés sont stockés sous ce chemin.

1. Envoyer le contenu de ce dossier dans un dépôt GitHub (branche `main`).
2. Dans Render, choisir **New + → Blueprint** et sélectionner ce dépôt. Render lit `render.yaml`.
3. Lors de la création, renseigner `ADMIN_PHONE` (indicatif pays, chiffres uniquement) et `ADMIN_PASSWORD` (10 caractères minimum).
4. Après création du service, récupérer son URL `https://...onrender.com` et renseigner cette URL dans `APP_BASE_URL`.
5. Ajouter dans Render les secrets `CHARIOW_API_KEY` et `CHARIOW_PULSE_SECRET`. Ne jamais les mettre dans GitHub ou dans le code navigateur.
6. Dans Chariow → Automatisations → Pulses, configurer l'URL `https://VOTRE-URL-RENDER/webhooks/chariow` pour l'événement `successful.sale`, puis utiliser le secret de signature correspondant dans Render.
7. Vérifier que les cinq produits Chariow sont publiés et que chacun coûte exactement le montant indiqué en XOF.

**Important :** le disque persistant Render nécessite un service payant. Ne pas déployer cette version avec SQLite sur un service gratuit sans disque : le système de fichiers est éphémère et la base, les comptes et les PDF risqueraient d'être perdus au redémarrage ou au redéploiement. Le disque attaché à un service Render ne peut être utilisé que par une seule instance.

## Vérifications

```bash
npm test
# ou directement : npm run test:features
```

Les tests couvrent les migrations, les fonctionnalités PDF/quiz, les accès privés, le webhook Chariow signé, les montants de dépôt et le webhook Chariow signé et la prévention du double crédit.

## Sécurité et exploitation

- Ne jamais publier `.env`, `data/`, les mots de passe, la clé API Chariow ou le secret Pulse.
- Changer les identifiants administrateur qui auraient été partagés dans une conversation.
- Configurer les informations légales de l'éditeur et les conditions de vente avant ouverture au public.
- Pour les nouveaux achats PDF, les gains sont comptabilisés chaque 24 h dans le suivi du produit puis versés en une seule fois au portefeuille de gains à l'échéance. Ils ne passent jamais par le portefeuille d'achat.
- La migration 008 conserve les achats antérieurs en mode historique afin d'éviter de verser une seconde fois des crédits déjà attribués.
- Les récompenses des quiz et les bonus de bienvenue/premier achat restent des crédits du portefeuille d'achat.
- Avant toute mise en production, vérifier le financement réel des récompenses, les conditions commerciales et les obligations légales locales ; ne pas présenter ces montants comme un rendement d'investissement garanti.


## Sécurité des paiements Chariow — V6.1

- Un crédit Chariow est déclenché uniquement par un webhook `successful.sale` dont la signature HMAC est valide.
- La commande est retrouvée par `sikaplus_order_id`, puis les métadonnées `sikaplus_user_id` et `sikaplus_amount`, le produit, le statut `completed`, le montant et la devise XOF sont rapprochés avec la commande SQLite.
- Le crédit du portefeuille, l'écriture du ledger, le passage de la commande à `completed` et l'enregistrement de la notification sont atomiques. Les notifications répétées ne créent pas de double crédit.
- Les dépôts Chariow ne peuvent pas être approuvés ou refusés manuellement dans l'administration. Les dépôts manuels conservent leur circuit de validation.
- Les notifications sont tracées dans `chariow_pulse_deliveries` et les crédits automatiques dans `admin_audit_logs`.
- La migration 005 ajoute uniquement des colonnes de traçabilité ; elle conserve les commandes et historiques existants.


## Dépôt SasPay (Softpay) — V7

Le client n'a plus à remplir nom, prénom ni email : ils viennent de son profil activé. Il choisit le montant, le réseau (T-Money ou Flooz) et saisit son numéro ; il valide ensuite sur son téléphone. Le crédit est automatique.

Variables d'environnement (Render) :
- `SASPAY_API_KEY` : clé secrète `sk_live_...` (ou `sk_test_...` pour le sandbox, détecté automatiquement), portée PAYIN ou BOTH.
- `SASPAY_WEBHOOK_SECRET` : secret de signature du webhook (affiché une seule fois à la création).
- `SASPAY_NETWORK_TMONEY` / `SASPAY_NETWORK_FLOOZ` : codes réseau SasPay pour le Togo (valeurs par défaut `tmoney_tg` et `moov_tg`, À VÉRIFIER via `GET /api/v1/networks/` avec votre clé).
- `APP_BASE_URL` : utilisé comme `return_url`.

Webhook à créer dans app.saspay.me → Webhooks : URL `https://VOTRE-URL/webhooks/saspay`, événements `transaction.success`, `transaction.failed`, `transaction.cancelled`.

Sécurité : signature HMAC-SHA256 et tolérance de 5 minutes ; le serveur revérifie le paiement auprès de SasPay (`/payments/{id}/verify/`) avant de créditer ; crédit atomique et unique ; suivi côté client toutes les 4 s en secours si le webhook tarde ; un seul paiement en cours par client. Test : `node tests/verify-saspay.js`.
