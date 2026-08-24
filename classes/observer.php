<?php
/**
 * Event observer callbacks. Each pushes a small lifecycle event to the SOAR
 * backend (POST /api/sync) using the shared secret configured in settings.php.
 */

namespace quizaccess_exammonitor;

defined('MOODLE_INTERNAL') || die();

class observer
{
    public static function course_created(\core\event\course_created $event): void
    {
        $course = $event->get_record_snapshot('course', $event->objectid);
        if (!$course) {
            return;
        }
        self::push('course_created', [
            'id' => (int)$course->id,
            'fullname' => (string)$course->fullname,
        ]);
    }

    public static function course_module_created(\core\event\course_module_created $event): void
    {
        // Only care about quiz modules.
        $other = $event->other;
        if (($other['modulename'] ?? '') !== 'quiz') {
            return;
        }
        $cm = get_coursemodule_from_id('quiz', $event->objectid, 0, false, MUST_EXIST);
        if (!$cm) {
            return;
        }
        $quiz = get_coursemodule_instance('quiz', $event->objectid, 0);
        if (!$quiz) {
            return;
        }
        self::push('quiz_created', [
            'id' => (int)$quiz->id,
            'course' => (int)$cm->course,
            'cmid' => (int)$cm->id,
            'name' => (string)$quiz->name,
        ]);
    }

    public static function user_created(\core\event\user_created $event): void
    {
        $user = $event->get_record_snapshot('user', $event->objectid);
        if (!$user) {
            return;
        }
        self::push('user_created', [
            'id' => (int)$user->id,
            'fullname' => fullname($user),
            'username' => (string)$user->username,
        ]);
    }

    public static function role_assigned(\core\event\role_assigned $event): void
    {
        global $DB;

        // Only course-context role assignments link a teacher to a course.
        if ($event->contextlevel != CONTEXT_COURSE) {
            return;
        }

        $role = $DB->get_record('role', ['id' => $event->objectid], 'id, archetype');
        if (!$role) {
            return;
        }
        // Only teacher-style roles reach the platform.
        if (!in_array($role->archetype, ['teacher', 'editingteacher'], true)) {
            return;
        }

        $user = $DB->get_record('user', ['id' => $event->relateduserid], 'id, username');
        if (!$user) {
            return;
        }

        self::push('role_assigned', [
            'userid' => (int)$user->id,
            'courseid' => (int)$event->courseid,
            'fullname' => fullname($user),
            'username' => (string)$user->username,
            'archetype' => (string)$role->archetype,
        ]);
    }

    public static function user_enrolment_deleted(\core\event\user_enrolment_deleted $event): void
    {
        self::push('user_enrolment_deleted', [
            'userid' => (int)$event->relateduserid,
            'courseid' => (int)$event->courseid,
        ]);
    }

    public static function user_deleted(\core\event\user_deleted $event): void
    {
        self::push('user_deleted', [
            'userid' => (int)$event->objectid,
        ]);
    }

    public static function role_unassigned(\core\event\role_unassigned $event): void
    {
        if ($event->contextlevel != CONTEXT_COURSE) {
            return;
        }

        self::push('role_unassigned', [
            'userid' => (int)$event->relateduserid,
            'courseid' => (int)$event->courseid,
        ]);
    }

    // ---------------------------------------------------------------

    private static function push(string $type, array $data): void
    {
        $server = get_config('quizaccess_exammonitor', 'sync_server');
        $secret = get_config('quizaccess_exammonitor', 'sync_secret');

        if ($server === false || $server === '' || $secret === false || $secret === '') {
            return; // Sync not configured yet.
        }
        $server = rtrim((string)$server, '/') . '/api/sync';

        $payload = json_encode([
            'secret' => (string)$secret,
            'type' => $type,
            'data' => $data,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $ch = curl_init($server);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 4,
            CURLOPT_CONNECTTIMEOUT => 2,
        ]);
        curl_exec($ch);
        curl_close($ch);
    }
}
