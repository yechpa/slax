import type { LegalText } from './types.ts'

export const fr: LegalText = {
  privacy: {
    title: 'Politique de confidentialité',
    updated: '2026-10-31',
    intro:
      'Slax est un projet personnel de démonstration, pas une entreprise : une messagerie d’équipe construite et exploitée par une seule personne (github.com/yechpa/slax). Cette page dit ce que Slax conserve sur vous, pourquoi, qui peut le voir et comment le faire effacer. Elle est courte, car Slax collecte peu de choses.',
    sections: [
      {
        id: 'what',
        heading: 'Ce que Slax conserve',
        blocks: [
          'La connexion se fait uniquement avec Google. Slax demande trois informations à Google (openid, e-mail, profil) et reçoit votre nom, votre adresse e-mail, votre photo de profil et un identifiant de votre compte Google. Il ne voit jamais votre mot de passe Google et ne demande rien d’autre (ni contacts, ni Drive, ni agenda).',
          [
            'Ce que vous écrivez : messages, réactions, salons et conversations que vous créez, et les fichiers que vous envoyez (ils sont analysés contre les logiciels malveillants, gardés dans un espace de stockage privé et jamais publics).',
            'Vos réglages : langue et thème.',
            'Présence : si vous êtes en ligne et qui est en train d’écrire. Elle reste en mémoire quelques secondes et n’est pas conservée.',
            'Notifications, seulement si vous les activez : l’adresse de notification de votre appareil et ses clés de chiffrement, jusqu’à ce que vous les désactiviez ou vous déconnectiez. Une notification indique l’expéditeur et le salon, jamais le texte d’un message.',
            'Journaux de sécurité : votre adresse IP et l’action, pour les actions des administrateurs, gardés 180 jours. Les limites de débit et votre session utilisent aussi votre adresse IP et votre navigateur tant qu’elles sont nécessaires.',
          ],
        ],
      },
      {
        id: 'cookies',
        heading: 'Cookies',
        blocks: [
          'Slax ne dépose que les cookies nécessaires à son fonctionnement : un cookie de session qui vous garde connecté (14 jours d’inactivité pour un compte connecté, 2 heures pour un visiteur non connecté) et un cookie de protection contre les requêtes falsifiées. Il n’y a ni publicité, ni statistiques, ni cookie de suivi. Vos choix de langue et de thème sont gardés dans le stockage de votre navigateur.',
        ],
      },
      {
        id: 'who',
        heading: 'Qui voit quoi',
        blocks: [
          [
            'Les membres voient votre nom, votre photo et vos messages dans les salons qu’ils peuvent ouvrir. Un message direct n’est visible que par ses participants.',
            'Les administrateurs peuvent modérer : supprimer, verrouiller, bannir, et lire le journal d’audit. La personne qui exploite le serveur a aussi un accès technique à la base de données et aux fichiers, comme tout hébergeur.',
            'Personne d’autre : vos données ne sont ni vendues, ni partagées à des fins publicitaires, ni utilisées pour entraîner quoi que ce soit.',
          ],
        ],
      },
      {
        id: 'demo',
        heading: 'La démonstration publique',
        blocks: [
          'Le site public est une démonstration ouverte à tout visiteur ayant un compte Google. Chaque nuit à 03:00 UTC, les comptes de démonstration, tout ce qu’ils ont écrit, les salons qu’ils ont créés et les conversations auxquelles ils ont pris part sont effacés. Les comptes des membres invités (famille et amis) sont conservés. Si vous écrivez sur la démonstration, n’y mettez rien que vous voulez garder.',
        ],
      },
      {
        id: 'providers',
        heading: 'Les services sur lesquels Slax s’appuie',
        blocks: [
          [
            'Google : la connexion.',
            'Cloudflare Turnstile : une vérification anti-robot à la connexion ; il reçoit des informations techniques sur votre navigateur.',
            'Amazon Web Services, Francfort (Allemagne) : l’hébergement du serveur, des fichiers envoyés et des sauvegardes de la base de données (gardées 35 jours).',
            'Le service de notifications de votre appareil (Apple, Google, Mozilla ou Microsoft), seulement si vous activez les notifications : il relaie la notification et voit son expéditeur, son salon et son heure, pas son texte.',
            'Telegram : un canal privé où l’administrateur reçoit les alertes d’erreur et de modération. Elles ne contiennent jamais le texte des messages.',
          ],
        ],
      },
      {
        id: 'keep',
        heading: 'Combien de temps c’est conservé',
        blocks: [
          'Les messages et les fichiers restent jusqu’à ce que vous ou un administrateur les supprimiez, ou que la remise à zéro nocturne efface un compte de démonstration. Un message supprimé est remplacé par une note indiquant qu’il a été supprimé. Les sauvegardes de la base expirent après 35 jours : une suppression est donc complète dans les sauvegardes sous 35 jours. Les journaux de sécurité sont purgés après 180 jours.',
        ],
      },
      {
        id: 'rights',
        heading: 'Vos choix',
        blocks: [
          'Vous pouvez vous déconnecter à tout moment (cela supprime aussi l’enregistrement de vos notifications), désactiver les notifications, et demander à voir, corriger, exporter ou supprimer ce que Slax détient sur vous, y compris votre compte. Écrivez à la personne qui exploite Slax via le contact ci-dessous ; il n’y a pas encore de formulaire automatique.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact et modifications',
        blocks: ['Questions et demandes : github.com/yechpa (profil public du mainteneur). Si cette politique change, la date en haut de la page change avec elle.'],
      },
    ],
  },
  terms: {
    title: 'Conditions d’utilisation',
    updated: '2026-10-31',
    intro:
      'En vous connectant à Slax, vous acceptez ces conditions. Slax est un projet personnel proposé gratuitement, pour montrer comment on construit une telle application.',
    sections: [
      {
        id: 'service',
        heading: 'Le service',
        blocks: [
          'Slax est fourni tel quel, sans promesse qu’il soit toujours disponible, sans erreur ou conservé pour toujours. Il peut changer, être interrompu ou arrêté à tout moment, et les données de la démonstration sont effacées chaque nuit. Gardez votre propre copie de ce qui compte.',
        ],
      },
      {
        id: 'use',
        heading: 'Bien l’utiliser',
        blocks: [
          'Vous ne pouvez pas utiliser Slax pour :',
          [
            'publier du contenu illégal, ou qui harcèle, menace, usurpe l’identité de quelqu’un ou le discrimine ;',
            'envoyer du spam ou des logiciels malveillants, ou téléverser des fichiers que vous n’avez pas le droit de partager ;',
            'attaquer le service ou ses utilisateurs, y chercher des failles sans l’accord écrit du mainteneur, ou contourner ses limites et ses protections ;',
            'créer des comptes en masse ou partager votre session avec d’autres personnes.',
          ],
        ],
      },
      {
        id: 'content',
        heading: 'Votre contenu',
        blocks: [
          'Ce que vous écrivez reste à vous. Vous autorisez Slax à le conserver et à l’afficher aux membres qui voient le salon ou la conversation où vous l’avez publié, et rien de plus. Vous êtes responsable de ce que vous publiez.',
        ],
      },
      {
        id: 'moderation',
        heading: 'Modération',
        blocks: [
          'Les administrateurs peuvent supprimer du contenu, verrouiller un salon, et suspendre ou bannir un compte, sans préavis, lorsque ces conditions ne sont pas respectées ou pour protéger le service et ses utilisateurs. Un compte banni reste enregistré pour qu’il ne puisse pas simplement se réinscrire.',
        ],
      },
      {
        id: 'liability',
        heading: 'Responsabilité',
        blocks: [
          'Dans la mesure où la loi le permet, le mainteneur n’est pas responsable des pertes causées par l’utilisation de Slax, par son indisponibilité ou par la perte de contenu. Rien ici ne limite les droits que la loi interdit de limiter.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact et modifications',
        blocks: ['Questions : github.com/yechpa. Ces conditions peuvent changer ; la date en haut de la page change avec elles, et utiliser Slax après un changement vaut acceptation.'],
      },
    ],
  },
}
