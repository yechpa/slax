<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/**
 * A task or list change refused by a rule: 422 with the rule's stable code as `error`
 * (`task_list_limit`, `task_limit`, `inbox_full`, `invalid_assignee`, `invalid_list`).
 */
class TaskRefused extends RuntimeException
{
    public function __construct(string $code)
    {
        parent::__construct($code);
    }

    public function render(): JsonResponse
    {
        return response()->json(['error' => $this->getMessage()], 422);
    }

    /** An expected outcome, not an error worth logging. */
    public function report(): void {}
}
