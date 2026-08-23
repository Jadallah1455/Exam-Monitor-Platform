<?php
/**
 * Teacher registration page (manual fallback).
 *
 * The RECOMMENDED path is fully automatic (rule.php save_settings + event
 * observers). This page exists so a teacher can manually re-register the
 * teacher <-> course <-> quiz mapping at any time.
 */

require_once(__DIR__ . '/../../../../config.php');

global $USER, $DB, $PAGE, $OUTPUT;

// Get course module ID from URL.
$cmid = required_param('cmid', PARAM_INT);

// Load quiz course module.
$cm = get_coursemodule_from_id(
    'quiz',
    $cmid,
    0,
    false,
    MUST_EXIST
);

// Require Moodle login.
require_login($cm->course, false, $cm);

// Get quiz context.
$context = context_module::instance($cm->id);

// Only users who can manage the quiz are allowed.
require_capability('mod/quiz:manage', $context);

// Load quiz data.
$quiz = $DB->get_record(
    'quiz',
    ['id' => $cm->instance],
    '*',
    MUST_EXIST
);

$course = $DB->get_record('course', ['id' => $cm->course], 'id, fullname', MUST_EXIST);

// Prepare teacher data.
$teacherData = [
    'secret' => (string) get_config('quizaccess_exammonitor', 'sync_secret'),
    'teacher_id' => (int) $USER->id,
    'teacher_name' => fullname($USER),
    'username' => $USER->username,
    'course_id' => (int) $cm->course,
    'course_name' => (string) $course->fullname,
    'quiz_id' => (int) $quiz->id,
    'quiz_name' => $quiz->name,
    'cmid' => (int) $cm->id
];

// Backend endpoint (same server as telemetry, different path).
$server = get_config('quizaccess_exammonitor', 'sync_server');
$backendUrl = rtrim((string) $server, '/') . '/register-teacher';

// Send teacher information to backend.
$ch = curl_init($backendUrl);

curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($teacherData));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json'
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 4);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 2);

$response = curl_exec($ch);
$error = curl_error($ch);

curl_close($ch);

// Moodle page settings.
$PAGE->set_url(
    new moodle_url('/mod/quiz/accessrule/exammonitor/teacher.php', [
        'cmid' => $cmid
    ])
);

$PAGE->set_context($context);
$PAGE->set_title('SOAR Dashboard');
$PAGE->set_heading('SOAR Dashboard');

echo $OUTPUT->header();

echo html_writer::tag('h3', 'SOAR Teacher Integration');

echo html_writer::tag(
    'p',
    'Teacher: ' . s(fullname($USER))
);

echo html_writer::tag(
    'p',
    'Course: ' . s($course->fullname)
);

echo html_writer::tag(
    'p',
    'Quiz: ' . s($quiz->name)
);

if (!$backendUrl || strpos($backendUrl, '127.0.0.1') !== false) {
    echo html_writer::tag('p', 'Backend is not configured (set sync_server in plugin settings).');
} elseif ($error) {
    echo html_writer::tag(
        'p',
        'Backend connection failed: ' . s($error)
    );
} else {
    $decoded = json_decode($response, true);
    $status = isset($decoded['ok']) && $decoded['ok'] ? 'success' : ($decoded['error'] ?? 'unknown');
    echo html_writer::tag(
        'p',
        'Teacher information sent to SOAR backend: ' . s($status)
    );
}

echo $OUTPUT->footer();
