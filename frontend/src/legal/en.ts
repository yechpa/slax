import type { LegalText } from './types.ts'

export const en: LegalText = {
  privacy: {
    title: 'Privacy policy',
    updated: '2026-10-31',
    intro:
      'Slax is a personal showcase project, not a company: a team chat built and run by one person (github.com/yechpa/slax). This page says what it stores about you, why, who can see it and how to have it removed. It is short because Slax collects little.',
    sections: [
      {
        id: 'what',
        heading: 'What Slax stores',
        blocks: [
          'Sign-in is only with Google. Slax asks Google for three things (openid, e-mail, profile) and receives your name, your e-mail address, your profile picture and an identifier of your Google account. It never sees your Google password and asks Google for nothing else (no contacts, no Drive, no calendar).',
          [
            'What you write: messages, reactions, channels and conversations you create, and the files you upload (they are scanned for malware, kept in a private storage space and never public).',
            'Your settings: language and theme.',
            'Presence: whether you are online and who is typing. It lives in memory for a few seconds and is not kept.',
            'Notifications, only if you turn them on: your device’s push address and its encryption keys, until you turn them off or sign out. A notification names the sender and the channel, never the text of a message.',
            'Security records: your IP address and the action, for administrators’ actions, kept 180 days. Rate limits and your session also use your IP address and browser while they are needed.',
          ],
        ],
      },
      {
        id: 'cookies',
        heading: 'Cookies',
        blocks: [
          'Slax sets only the cookies it needs to work: a session cookie that keeps you signed in (14 days of inactivity for a signed-in account, 2 hours for a visitor who did not sign in) and a protection cookie against forged requests. There is no advertising, no analytics and no tracking cookie. Your language and theme choices are kept in your browser’s storage.',
        ],
      },
      {
        id: 'who',
        heading: 'Who sees what',
        blocks: [
          [
            'Members see your name, picture and messages in the channels they can open. A direct message is visible only to its participants.',
            'Administrators can moderate: delete, lock, ban, and read the audit log. The person who runs the server also has technical access to the database and the files, as any host does.',
            'Nobody else: your data is not sold, shared for advertising, or used to train anything.',
          ],
        ],
      },
      {
        id: 'demo',
        heading: 'The public demo',
        blocks: [
          'The public site is a demonstration open to any visitor with a Google account. Every night at 03:00 UTC the demo accounts, everything they wrote, the channels they created and the conversations they took part in are erased. Accounts of invited members (family and friends) are kept. If you write on the demo, do not put anything there you want to keep.',
        ],
      },
      {
        id: 'providers',
        heading: 'Services Slax relies on',
        blocks: [
          [
            'Google: sign-in.',
            'Cloudflare Turnstile: an anti-robot check when you sign in; it receives technical information about your browser.',
            'Amazon Web Services, Frankfurt (Germany): hosting of the server, the uploaded files and the database backups (kept 35 days).',
            'Your device’s push service (Apple, Google, Mozilla or Microsoft), only if you enable notifications: it relays the notification and sees its sender, channel and time, not its text.',
            'Telegram: a private channel where the administrator receives error and moderation alerts. They never contain message text.',
          ],
        ],
      },
      {
        id: 'keep',
        heading: 'How long it is kept',
        blocks: [
          'Messages and files stay until you or an administrator delete them, or the nightly reset erases a demo account. A deleted message is replaced by a note saying it was deleted. Database backups expire after 35 days, so a deletion is complete in backups within 35 days. Security records are pruned after 180 days.',
        ],
      },
      {
        id: 'rights',
        heading: 'Your choices',
        blocks: [
          'You can sign out at any time (it also removes your notification registration), turn notifications off, and ask to see, correct, export or delete what Slax holds about you, including your account. Write to the person who runs Slax through the contact below; there is no automated form yet.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact and changes',
        blocks: ['Questions and requests: github.com/yechpa (public profile of the maintainer). If this policy changes, the date at the top changes with it.'],
      },
    ],
  },
  terms: {
    title: 'Terms of use',
    updated: '2026-10-31',
    intro: 'By signing in to Slax you accept these terms. Slax is a personal project offered free of charge, to show how such an application is built.',
    sections: [
      {
        id: 'service',
        heading: 'The service',
        blocks: [
          'Slax is provided as it is, with no promise that it is always available, free of errors or kept forever. It can change, be interrupted or be shut down at any time, and demo data is erased every night. Keep your own copy of anything that matters.',
        ],
      },
      {
        id: 'use',
        heading: 'Using it properly',
        blocks: [
          'You may not use Slax to:',
          [
            'post illegal content, or content that harasses, threatens, impersonates or discriminates against someone;',
            'send spam or malware, or upload files you have no right to share;',
            'attack the service or its users, probe it for weaknesses without the maintainer’s written agreement, or work around its limits and protections;',
            'create accounts in bulk or share your session with others.',
          ],
        ],
      },
      {
        id: 'content',
        heading: 'Your content',
        blocks: [
          'What you write stays yours. You allow Slax to store it and show it to the members who can see the channel or conversation where you posted it, and nothing more. You are responsible for what you post.',
        ],
      },
      {
        id: 'moderation',
        heading: 'Moderation',
        blocks: [
          'Administrators can delete content, lock a channel, and suspend or ban an account, without notice, when these terms are broken or to protect the service and its users. A banned account stays recorded so that it cannot simply sign up again.',
        ],
      },
      {
        id: 'liability',
        heading: 'Liability',
        blocks: [
          'To the extent the law allows, the maintainer is not liable for losses caused by using Slax, by its unavailability or by lost content. Nothing here limits rights that the law does not allow to be limited.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact and changes',
        blocks: ['Questions: github.com/yechpa. These terms may change; the date at the top changes with them, and using Slax after a change means accepting it.'],
      },
    ],
  },
}
