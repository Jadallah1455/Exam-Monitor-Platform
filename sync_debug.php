<?php
/**
 * Debug endpoint — returns raw Moodle data counts without pushing to backend.
 * Call from Moodle admin or browser: mod/quiz/accessrule/exammonitor/sync_debug.php
 * Must be logged in as Moodle admin.
 */

require_once(__DIR__ . '/../../../../config.php');
require_login();

if (!has_capability('moodle/site:config', context_system::instance())) {
    print_error('Admin only');
}

global $DB;

$debug = [];

// 1. Count courses (excluding site course id=1)
$courses = $DB->get_records_sql("SELECT id, fullname FROM {course} WHERE id > 1 ORDER BY id");
$debug['courses'] = count($courses);
$debug['courses_list'] = array_map(fn($c) => ['id' => $c->id, 'name' => $c->fullname], $courses);

// 2. Count role assignments by context level
$contextCounts = $DB->get_records_sql(
    "SELECT c.contextlevel, COUNT(*) AS cnt
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
      GROUP BY c.contextlevel"
);
$debug['context_levels'] = [];
foreach ($contextCounts as $row) {
    $debug['context_levels'][$row->contextlevel] = (int)$row->cnt;
}

// CONTEXT_COURSE constant
$debug['context_course_constant'] = CONTEXT_COURSE;

// 3. Count roles by archetype
$roleCounts = $DB->get_records_sql(
    "SELECT archetype, COUNT(*) AS cnt FROM {role} GROUP BY archetype"
);
$debug['roles'] = [];
foreach ($roleCounts as $row) {
    $debug['roles'][$row->archetype] = (int)$row->cnt;
}

// 4. Teachers (editingteacher or teacher)
$teachers = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype IN ('teacher','editingteacher') AND u.deleted = 0
      ORDER BY u.id"
);
$debug['teachers'] = count($teachers);
$debug['teachers_list'] = array_map(fn($t) => ['id' => $t->id, 'username' => $t->username, 'name' => trim("$t->firstname $t->lastname")], $teachers);

// 5. Students
$students = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype = 'student' AND u.deleted = 0
      ORDER BY u.id"
);
$debug['students'] = count($students);
$debug['students_list'] = array_map(fn($s) => ['id' => $s->id, 'username' => $s->username, 'name' => "$s->firstname $s->lastname"], $students);

// 6. Quizzes
$quizzes = $DB->get_records_sql(
    "SELECT q.id, q.name, q.course
       FROM {quiz} q
       ORDER BY q.id"
);
$debug['quizzes'] = count($quizzes);
$debug['quizzes_list'] = array_map(fn($q) => ['id' => $q->id, 'name' => $q->name, 'course' => $q->course], $quizzes);

// 7. Users table count
$debug['total_users'] = (int)$DB->get_field_sql("SELECT COUNT(*) FROM {user} WHERE deleted = 0");

header('Content-Type: application/json; charset=utf-8');
echo json_encode($debug, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
