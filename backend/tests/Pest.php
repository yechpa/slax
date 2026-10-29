<?php

use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| Feature tests boot the Laravel application; Unit tests stay framework-free.
|
*/

pest()->extend(TestCase::class)->in('Feature');
