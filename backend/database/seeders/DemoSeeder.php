<?php

namespace Database\Seeders;

use App\Models\Channel;
use App\Models\Message;
use App\Models\Reaction;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Ramsey\Uuid\Uuid;

/**
 * The public demo's content: a few fictional people (`seed` accounts, which never sign in)
 * talking in the starter channels, in English, Hebrew and French, with a thread and
 * reactions. Nothing in it is anybody's real data.
 *
 * Idempotent, and a restore as much as a seed: run again (slax:demo-reset does, nightly),
 * it puts the starter channels' topics, the seed messages (bodies, thread, not deleted, not
 * edited) and the reactions on them (anyone's) back as defined here, and removes seed
 * messages no longer defined. Other messages and channels are left alone.
 */
class DemoSeeder extends Seeder
{
    /** Seed accounts' Google subject: `seed:<key>` (Google subjects are digits, so it never collides). */
    public const SUB_PREFIX = 'seed:';

    /** @var array<string, array{name: string, locale: string}> */
    public const PEOPLE = [
        'sam' => ['name' => 'Sam Carter', 'locale' => 'en'],
        'noa' => ['name' => 'נועה לוי', 'locale' => 'he'],
        'camille' => ['name' => 'Camille Martin', 'locale' => 'fr'],
        'avi' => ['name' => 'Avi Ben-David', 'locale' => 'he'],
    ];

    /**
     * In posting order; `reply_to` makes a thread reply to an earlier key of the same channel.
     *
     * @var list<array{key: string, channel: string, by: string, body: string, reply_to?: string}>
     */
    public const MESSAGES = [
        ['key' => 'general.welcome', 'channel' => 'general', 'by' => 'sam', 'body' => 'Welcome to Slax! This is a live demo: say hello, start a thread, react, share a file. Everything here goes back to this state every night.'],
        ['key' => 'general.shalom', 'channel' => 'general', 'by' => 'noa', 'body' => 'שלום לכולם! אפשר לכתוב כאן בעברית, וגם לשלב English באמצע המשפט בלי בעיה.'],
        ['key' => 'general.bonjour', 'channel' => 'general', 'by' => 'camille', 'body' => 'Bonjour à tous ! On peut aussi écrire en français ici, accents compris : é, è, ç, à.'],
        ['key' => 'general.welcome.thread-1', 'channel' => 'general', 'by' => 'camille', 'reply_to' => 'general.welcome', 'body' => 'Merci ! Les réponses comme celle-ci forment un fil de discussion.'],
        ['key' => 'general.welcome.thread-2', 'channel' => 'general', 'by' => 'noa', 'reply_to' => 'general.welcome', 'body' => 'וגם שרשורים עובדים מימין לשמאל 👍'],
        ['key' => 'general.welcome.thread-3', 'channel' => 'general', 'by' => 'sam', 'reply_to' => 'general.welcome', 'body' => 'Three languages, one thread.'],
        ['key' => 'random.coffee', 'channel' => 'random', 'by' => 'avi', 'body' => 'Coffee or tea? ☕'],
        ['key' => 'random.coffee-reply', 'channel' => 'random', 'by' => 'noa', 'body' => 'קפה. תמיד קפה.'],
        ['key' => 'random.croissant', 'channel' => 'random', 'by' => 'camille', 'body' => 'Thé, et un croissant 🥐'],
        ['key' => 'ingenierie.ci', 'channel' => 'ingenierie', 'by' => 'camille', 'body' => "Chaque fusion passe par la CI : tests, images amd64 et arm64, puis déploiement automatique sur le dev.\n`make test` lance tout en local."],
        ['key' => 'ingenierie.scanner', 'channel' => 'ingenierie', 'by' => 'sam', 'body' => 'Uploads go through the scanner first: the real type is detected from the bytes, not from the name.'],
        ['key' => 'ingenierie.rtl', 'channel' => 'ingenierie', 'by' => 'avi', 'body' => 'בדקתי את התצוגה מימין לשמאל: ה־CSS כולו בתכונות לוגיות.'],
        ['key' => 'securite.secrets', 'channel' => 'securite', 'by' => 'noa', 'body' => 'תזכורת: אין להדביק סודות או מפתחות בערוץ. Rotate anything you pasted by mistake.'],
        ['key' => 'securite.sessions', 'channel' => 'securite', 'by' => 'camille', 'body' => 'Rappel : la connexion se fait uniquement par Google, sans mot de passe propre à Slax.'],
    ];

    /** @var list<array{message: string, by: string, emoji: string}> */
    public const REACTIONS = [
        ['message' => 'general.welcome', 'by' => 'noa', 'emoji' => '👋'],
        ['message' => 'general.welcome', 'by' => 'camille', 'emoji' => '👋'],
        ['message' => 'general.welcome', 'by' => 'avi', 'emoji' => '🎉'],
        ['message' => 'general.shalom', 'by' => 'sam', 'emoji' => '❤️'],
        ['message' => 'random.coffee', 'by' => 'noa', 'emoji' => '☕'],
    ];

    /** Fixed namespace: a seed message's client_id is derived from its key. */
    private const UUID_NAMESPACE = '0b5a9a6e-7f1e-4d55-9e3b-5c1a7d4f2e10';

    public static function clientId(string $key): string
    {
        return Uuid::uuid5(self::UUID_NAMESPACE, $key)->toString();
    }

    public function run(): void
    {
        (new DefaultWorkspaceSeeder)->run();

        DB::transaction(function () {
            $channels = $this->restoreChannels();
            $people = $this->restorePeople($channels);
            $messages = $this->restoreMessages($channels, $people);
            $this->restoreReactions($messages, $people);
        });
    }

    /** @return array<string, Channel> the starter channels by name, topics as defined */
    private function restoreChannels(): array
    {
        $workspace = Workspace::default();
        $channels = [];
        foreach (DefaultWorkspaceSeeder::CHANNELS as $name => $topic) {
            $channel = Channel::where('workspace_id', $workspace->id)->where('name', $name)->firstOrFail();
            if ($channel->topic !== $topic) {
                $channel->forceFill(['topic' => $topic])->save();
            }
            $channels[$name] = $channel;
        }

        return $channels;
    }

    /**
     * @param  array<string, Channel>  $channels
     * @return array<string, User>
     */
    private function restorePeople(array $channels): array
    {
        $people = [];
        foreach (self::PEOPLE as $key => $person) {
            $user = User::firstOrNew(['google_sub' => self::SUB_PREFIX.$key]);
            // Reserved, non-routable domain (RFC 2606): not anybody's address.
            $user->forceFill([
                'email' => "{$key}@seed.slax.invalid",
                'name' => $person['name'],
                'locale' => $person['locale'],
                'account_type' => User::ACCOUNT_SEED,
                'is_admin' => false,
                'banned_at' => null,
            ])->save();

            foreach ($channels as $channel) {
                $channel->addMember($user);
            }
            $people[$key] = $user;
        }

        return $people;
    }

    /**
     * @param  array<string, Channel>  $channels
     * @param  array<string, User>  $people
     * @return array<string, Message> by key
     */
    private function restoreMessages(array $channels, array $people): array
    {
        $messages = [];
        foreach (self::MESSAGES as $seed) {
            $author = $people[$seed['by']];
            $message = Message::firstOrNew(['user_id' => $author->id, 'client_id' => self::clientId($seed['key'])]);
            $message->forceFill([
                'channel_id' => $channels[$seed['channel']]->id,
                'parent_id' => isset($seed['reply_to']) ? $messages[$seed['reply_to']]->id : null,
                'body' => $seed['body'],
                'edited_at' => null,
                'deleted_at' => null,
            ]);
            if ($message->isDirty()) {
                $message->save();
            }
            $messages[$seed['key']] = $message;
        }

        // Seed messages that are no longer defined.
        $keep = collect($messages)->map->id->values()->all();
        Message::whereIn('user_id', collect($people)->map->id->values())->whereNotIn('id', $keep)->delete();

        return $messages;
    }

    /**
     * Seed messages carry exactly the seed reactions.
     *
     * @param  array<string, Message>  $messages
     * @param  array<string, User>  $people
     */
    private function restoreReactions(array $messages, array $people): void
    {
        Reaction::whereIn('message_id', collect($messages)->map->id->values())->delete();

        $now = now();
        DB::table('reactions')->insert(array_map(fn (array $reaction) => [
            'message_id' => $messages[$reaction['message']]->id,
            'user_id' => $people[$reaction['by']]->id,
            'emoji' => $reaction['emoji'],
            'created_at' => $now,
        ], self::REACTIONS));
    }
}
