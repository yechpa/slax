<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| Feature tests boot the Laravel application on a real PostgreSQL database
| that is rolled back between tests; Unit tests stay framework-free.
|
*/

pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');
