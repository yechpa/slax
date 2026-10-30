<?php

namespace App\Http\Controllers;

use App\Services\Identity\E2eIdentityProvider;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * The account chooser of the end-to-end stack: where the browser lands instead of Google's
 * consent page (E2eIdentityProvider). Its routes are registered only when APP_ENV is `e2e`
 * (routes/web.php), and each action checks it again.
 */
class E2eSignInController extends Controller
{
    /** GET /auth/e2e/google?state&nonce: a form asking who signs in. */
    public function chooser(Request $request): Response
    {
        abort_unless(app()->environment('e2e'), 404);

        $state = e((string) $request->query('state', ''));
        $nonce = e((string) $request->query('nonce', ''));

        return response(<<<HTML
            <!doctype html>
            <html lang="en">
            <meta charset="utf-8">
            <title>Fake Google (e2e)</title>
            <h1>Fake Google account chooser (end-to-end tests only)</h1>
            <form method="get" action="/auth/e2e/google/approve">
              <input type="hidden" name="state" value="{$state}">
              <input type="hidden" name="nonce" value="{$nonce}">
              <p><label>Email <input name="email" type="email" required></label></p>
              <p><label>Name <input name="name" required></label></p>
              <p><label><input name="email_verified" type="checkbox" value="1" checked> Email verified</label></p>
              <p><button type="submit">Continue</button></p>
            </form>
            </html>
            HTML)->header('Content-Type', 'text/html; charset=utf-8');
    }

    /** GET /auth/e2e/google/approve: back to the real callback, like Google after consent. */
    public function approve(Request $request): RedirectResponse
    {
        abort_unless(app()->environment('e2e'), 404);

        $data = $request->validate([
            'state' => ['required', 'string', 'max:100'],
            'nonce' => ['required', 'string', 'max:100'],
            'email' => ['required', 'email', 'max:254'],
            'name' => ['required', 'string', 'max:100'],
        ]);

        $code = E2eIdentityProvider::code([
            'email' => $data['email'],
            'name' => $data['name'],
            'email_verified' => $request->boolean('email_verified'),
        ], $data['nonce']);

        return redirect('/auth/google/callback?'.http_build_query(['code' => $code, 'state' => $data['state']]));
    }
}
