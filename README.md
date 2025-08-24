# MVP – Analyse de la Qualité de l’Air (Atelier de Céramique)

Ce projet est un **MVP (Minimum Viable Product)** de tableau de bord pour analyser la qualité de l’air dans un atelier de céramique. Il s’agit d’une application web 100% statique (HTML/JS/CSS) qui interroge une base de données **Supabase** via des procédures stockées (RPC) sécurisées. L’interface est monopage, responsive, et conforme à la charte graphique définie.

## Fonctionnalités

- **Indicateurs clés (KPI)** – Affiche trois indicateurs calculés sur la période sélectionnée : le nombre total de pics de pollution, le nombre de pics par heure, et le pourcentage du temps où la concentration de particules PM2.5 dépasse 15 µg/m³. Chaque indicateur est accompagné d’une pastille de couleur avec icône (vert, jaune ou rouge) indiquant l’état : vert = bon, jaune = moyen, rouge = mauvais (selon des seuils paramétrés).
- **Graphiques temporels** – Montre l’évolution des concentrations de particules fines **PM1**, **PM2.5** et **PM10** au cours du temps, sous forme de courbes. Chaque graphique correspond à une mesure (PM1, PM2.5, PM10) et se met à jour dynamiquement en fonction de la plage de dates sélectionnée. Les graphiques utilisent Plotly et offrent des interactions natives : info-bulles au survol, zoom/dézoom (sélectionner une zone ou utiliser les contrôles), et redéfinition de l’échelle temporelle.
- **Tableau des activités** – Pour chaque activité enregistrée dans l’atelier (étiquetée dans les données), affiche la durée totale pendant la période choisie, le nombre de pics survenus durant cette activité, et le ratio de pics par heure. Ce tableau permet d’identifier quelles activités sont associées à davantage de pics de pollution.
- **Liste des pics** – Liste chronologique de tous les **pics de pollution** détectés pendant la plage de dates sélectionnée (dépassements du seuil de 15 µg/m³ en PM2.5). Pour chaque pic, on affiche la date/heure (heure de Paris) et la valeur mesurée (µg/m³). Cela permet de consulter le détail des événements de pollution et de les rapprocher éventuellement des activités en cours.

## Prérequis

- Un compte Supabase et un **projet Supabase** configuré.
- Les fichiers front-end du projet (fournis dans ce repository) : `index.html`, `styles.css`, `main.js`, `config.example.js` (à renommer), et le présent `README.md`.
- Le script SQL de création de la base de données Supabase (non fourni ici) contenant les tables de mesures et les fonctions RPC suivantes : `kpis_peaks_range`, `time_series_bucketed`, `peaks_in_range`, `summary_by_tag_range`, `readings_extent`. **Assurez-vous d’avoir ces procédures dans votre base** avec les bonnes définitions (selon votre modèle de données).

## Installation et Configuration

1. **Créer le projet Supabase** – Connectez-vous à Supabase et créez un nouveau projet. Notez l’URL du projet (format `https://xyzcompany.supabase.co`) et la **clé API anonyme** (dans Settings > API > Project API keys).
2. **Importer le schéma SQL** – Dans l’onglet “SQL Editor” de votre projet Supabase, exécutez le script SQL d’importation qui crée les tables nécessaires (mesures, activités, etc.) et les fonctions RPC mentionnées ci-dessus. Assurez-vous que les noms de fonctions et de colonnes correspondent bien à ceux utilisés dans le code front-end.
3. **Configurer le front-end** – Renommez le fichier `config.example.js` en `config.js`. Ouvrez-le et renseignez vos identifiants Supabase :
   ```js
   window.SUPABASE_URL = "https://<ID_PROJET>.supabase.co";
   window.SUPABASE_ANON_KEY = "<CLE_API_ANONYME>";
