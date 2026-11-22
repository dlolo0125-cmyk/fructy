# SikaPlus V2 — Cahier des charges technique

**Version :** 2.0 — fondation alpha  
**Positionnement :** plateforme de formation numérique destinée à l'Afrique francophone.  
**Périmètre validé :** vidéos + PDF + quiz ; paiements Mobile Money ; achat individuel par formation ; service en ligne 24 h/24.

## 1. Vision produit

SikaPlus est une plateforme d'apprentissage. Le produit principal vendu est une formation structurée, composée de modules et de leçons. Les récompenses et le parrainage sont des fonctions secondaires de fidélisation, financées par un budget commercial réel et soumises à des règles publiques. Aucun rendement, revenu garanti ou rémunération liée au simple recrutement ne doit être promis.

## 2. Public et couverture géographique

- Première cible : utilisateurs francophones en Afrique de l'Ouest et centrale.
- Interface initiale en français, responsive mobile-first.
- Pays, indicatif téléphonique, prestataire de paiement et devise configurables.
- XOF et XAF doivent être gérés comme des devises distinctes. Ne jamais convertir ni mélanger des montants sans taux et date de conversion enregistrés.
- La disponibilité de chaque opérateur Mobile Money doit être confirmée pays par pays et auprès d'un prestataire agréé.

## 3. Périmètre fonctionnel

### 3.1 Visiteur
- Voir les formations publiées, catégories, niveaux, prix, durée, aperçu et conditions.
- Consulter les pages légales, politique de confidentialité, conditions de vente et règles de remboursement.
- Créer un compte ou se connecter.

### 3.2 Étudiant
- Profil et coordonnées ; vérification du numéro selon le pays et le fournisseur OTP retenu.
- Catalogue avec recherche, filtres, catégories et détails de formation.
- Achat individuel d'une formation.
- Accès aux cours uniquement après confirmation du paiement côté serveur.
- Lecteur vidéo, lecture de PDF, leçons textuelles et quiz.
- Reprise de lecture et progression synchronisée.
- Historique des achats, paiements et reçus.
- Certificat vérifiable si les critères pédagogiques sont atteints.
- Notifications et centre d'assistance.
- Parrainage et récompenses visibles avec règles, plafonds et statut.

### 3.3 Formateur / éditeur (phase ultérieure)
- Création et édition de brouillons.
- Dépôt de ressources, organisation en modules et leçons.
- Prévisualisation avant publication.
- Les droits d'un formateur ne donnent aucun accès aux paiements, soldes ou paramètres de sécurité.

### 3.4 Administrateur
- Gestion des utilisateurs, rôles et suspensions.
- Gestion des catégories, formations, modules, leçons, vidéos, PDF et quiz.
- Publication / dépublication et contrôle des contenus.
- Suivi des ventes, paiements, remboursements et rapprochement.
- Gestion des campagnes de récompenses et des règles de parrainage.
- Notifications et annonces.
- Rapports exportables.
- Journal d'audit obligatoire pour les actions sensibles.
- Authentification renforcée, TOTP conservé, rôles et permissions séparés.

## 4. Parcours d'achat Mobile Money

1. L'étudiant sélectionne une formation et le serveur calcule le prix, la devise et l'identifiant de commande.
2. Le serveur crée une commande/paiement `pending` avec une clé d'idempotence unique.
3. Un adaptateur de paiement initie la demande auprès du prestataire configuré pour le pays et l'opérateur.
4. L'utilisateur confirme sur son téléphone selon le parcours du fournisseur.
5. Le serveur reçoit un webhook HTTPS. Il vérifie la signature, l'identifiant d'événement, la référence, le montant, la devise, le bénéficiaire et le statut auprès du fournisseur si son API le permet.
6. Le webhook est traité de façon idempotente. Une même notification ne peut confirmer deux fois une commande.
7. Dans une transaction SQLite, le paiement passe à `confirmed` et l'inscription à la formation est créée une seule fois.
8. En cas d'échec, d'expiration ou d'annulation, aucun accès payant n'est accordé.
9. Un rapprochement périodique compare les paiements locaux aux rapports du fournisseur.

**Interdictions :** faire confiance à une capture d'écran ou à une référence saisie librement ; débloquer une formation depuis le navigateur ; accepter un montant ou une devise fournis par le client sans recalcul serveur ; traiter deux fois un webhook ; stocker un PIN Mobile Money.

## 5. Architecture cible

- Runtime : Node.js 22.13+ ; serveur HTTP actuel conservé pour la première transition.
- Base : SQLite avec WAL pour la première version en ligne, sur disque persistant et avec un seul processus applicatif écrivant dans la base.
- Déploiement : HTTPS, domaine, sauvegardes externes, supervision et restauration testée.
- Fichiers : stockage privé hors du répertoire public ; URLs temporaires signées ou contrôleur d'accès serveur pour les contenus payants.
- Paiement : interface d'adaptateur (`createPayment`, `verifyWebhook`, `queryPayment`, `refundPayment`) ; aucun fournisseur n'est codé en dur avant le choix et l'ouverture du compte marchand.
- Notifications : service central ; email/SMS/WhatsApp seulement via fournisseurs et consentements configurés.
- Évolution : migration possible vers PostgreSQL et stockage objet lorsque la charge ou le multi-instance l'exigera.

### Modules logiciels
- Authentification et profils.
- Catalogue et gestion pédagogique.
- Inscriptions et progression.
- Quiz et certificats.
- Paiements et rapprochement.
- Récompenses et parrainage.
- Notifications et support.
- Administration, permissions et audit.

## 6. Modèle de données V2

Les nouvelles tables ajoutées par la migration 001 sont :

- `course_categories`, `courses`, `course_modules`, `lessons` : catalogue et contenu pédagogique.
- `enrollments`, `lesson_progress` : accès et progression.
- `quizzes`, `quiz_questions`, `quiz_attempts` : évaluations.
- `certificates` : attestations vérifiables.
- `payments`, `payment_events` : paiement, événements fournisseur et idempotence.
- `reward_campaigns`, `reward_claims`, `referral_rewards` : fidélisation encadrée.
- `notifications` : messages utilisateur.
- `admin_audit_logs` : traçabilité des actions d'administration.
- `schema_migrations` : versions et empreintes des migrations.

Les tables V1 (`profiles`, `products`, `purchases`, `deposits`, `withdrawals`, `ledger`, `task_log`, `deposit_options`, `announcements`) ne sont ni supprimées ni renommées par cette première migration.

## 7. Contrats API cibles

Toutes les routes privées exigent une session valide et un contrôle d'autorisation côté serveur. Réponses JSON uniformes ; pagination par curseur ou page ; validation stricte des entrées.

| Méthode | Route cible | Accès | But |
|---|---|---|---|
| GET | `/api/v2/catalog/courses` | public | Catalogue publié |
| GET | `/api/v2/catalog/courses/:slug` | public | Détail et aperçu |
| POST | `/api/v2/payments` | étudiant | Créer une intention d'achat |
| GET | `/api/v2/payments/:id` | propriétaire/admin | Consulter le statut |
| POST | `/api/v2/payments/webhooks/:provider` | fournisseur | Webhook signé et idempotent |
| GET | `/api/v2/me/enrollments` | étudiant | Mes formations |
| GET | `/api/v2/me/courses/:id` | étudiant inscrit | Modules et leçons autorisés |
| PUT | `/api/v2/me/lessons/:id/progress` | étudiant inscrit | Sauver la progression |
| POST | `/api/v2/quizzes/:id/attempts` | étudiant inscrit | Soumettre un quiz |
| GET | `/api/v2/me/certificates` | étudiant | Mes certificats |
| GET/POST | `/api/v2/me/referrals` | étudiant | Code et suivi du parrainage |
| GET | `/api/v2/me/notifications` | étudiant | Notifications |
| POST/PUT | `/api/v2/admin/courses` | admin pédagogique | Gérer les formations |
| POST/PUT | `/api/v2/admin/lessons` | admin pédagogique | Gérer les leçons |
| GET | `/api/v2/admin/payments` | finance/admin | Suivi et rapprochement |
| POST | `/api/v2/admin/rewards/:id/review` | admin habilité | Valider une récompense |

Ces routes constituent le contrat cible ; elles ne sont pas toutes implémentées dans l'alpha de migration.

## 8. Sécurité et conformité

- HTTPS obligatoire en production ; HSTS après validation du domaine.
- Secrets dans variables d'environnement / coffre de secrets ; aucun secret dans Git ou ZIP public.
- Cookies de session `HttpOnly`, `Secure`, `SameSite` à privilégier lors de la refonte de l'authentification ; rotation et révocation des sessions.
- Politique de mot de passe renforcée, limitation des tentatives persistante, OTP téléphone si nécessaire.
- Contrôle de rôle sur chaque route, validation côté serveur et protection CSRF si authentification par cookie.
- Vérification de signature webhook, idempotence, rapprochement et journal d'audit.
- Journal financier append-only ; toute correction passe par une écriture compensatoire, jamais par l'effacement d'une opération.
- Fichiers contrôlés (taille, type réel, antivirus si disponible), stockage privé et autorisation à chaque téléchargement.
- Sauvegardes chiffrées, test de restauration et plan de reprise.
- Politique de confidentialité, consentement, conservation et suppression conformes aux lois des pays servis.
- Validation juridique des ventes numériques, fiscalité, paiements, récompenses et parrainage dans chaque marché.

## 9. Exigences non fonctionnelles

- Mobile-first, fonctionnement correct sur Android à faible bande passante.
- Pages catalogue légères ; images optimisées ; vidéo adaptative hébergée via un service adapté.
- Disponibilité cible initiale : 99,5 % mensuelle, hors maintenance annoncée.
- Temps de réponse cible API p95 inférieur à 500 ms hors appels fournisseurs et transferts média.
- Accessibilité clavier, contrastes et libellés de formulaires.
- Fuseurs horaires stockés en UTC ; affichage local selon pays.
- Montants stockés en unités entières de la plus petite unité monétaire ; devise toujours explicite.
- Logs structurés, erreurs sans secrets ni données sensibles, alertes sur échecs de paiement et espace disque.

## 10. Critères d'acceptation avant ouverture au public

1. Un utilisateur non payé ne peut pas accéder à une leçon protégée en appelant directement l'API ou l'URL du fichier.
2. Un paiement confirmé par webhook signé crée exactement une inscription, même si le webhook est reçu plusieurs fois.
3. Un webhook invalide ou montant/devise incorrect ne débloque aucun cours.
4. Une annulation, un échec ou un remboursement applique les règles d'accès définies et laisse une trace d'audit.
5. Un étudiant ne peut lire que sa progression, ses paiements et ses certificats.
6. Un certificat ne peut être émis qu'après validation des conditions de complétion et du quiz.
7. Une récompense ne peut pas dépasser le budget restant de sa campagne.
8. Les actions administratives sensibles sont journalisées avec acteur, cible, date et résultat.
9. Une sauvegarde peut être restaurée sur un environnement isolé et les comptes/historiques restent cohérents.
10. Les tests de migration prouvent que les comptes, produits, achats, dépôts, retraits, journaux et parrainages V1 sont conservés.

## 11. Phasage

- **Lot 0 — sécurisation et migration :** sauvegarde, migration additive, secrets, environnement de production.
- **Lot 1 — LMS :** catégories, cours, modules, leçons, médias, accès, progression.
- **Lot 2 — évaluations :** quiz, tentatives, certificats et vérification publique des certificats.
- **Lot 3 — paiements :** choix du prestataire, sandbox, webhooks, rapprochement, remboursements et reçus.
- **Lot 4 — fidélisation :** récompenses à budget plafonné, parrainage anti-fraude, notifications.
- **Lot 5 — exploitation :** administration complète, support, observabilité, tests de charge et lancement pays par pays.

## 12. Points bloquants à décider avant intégration paiement

- Pays de lancement prioritaires (au moins un pays pilote).
- Prestataire/agrégateur Mobile Money disponible et contrat marchand.
- Devises et opérateurs activés dans chaque pays.
- Règles de remboursement et service client.
- Prix des formations, fiscalité et politique de commission.
- Politique de récompense et budget réel, après avis juridique.
