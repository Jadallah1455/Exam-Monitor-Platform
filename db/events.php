<?php
/**
 * Event observers: forward Moodle lifecycle events to the SOAR backend so the
 * platform knows about new courses, quizzes, teachers and role assignments
 * the moment they happen - without waiting for a student to take an exam.
 */

defined('MOODLE_INTERNAL') || die();

$observers = [
    [
        'eventname'   => '\core\event\course_created',
        'callback'    => '\quizaccess_exammonitor\observer::course_created',
        'includefile' => '/mod/quiz/accessrule/exammonitor/classes/observer.php',
    ],
    [
        'eventname'   => '\core\event\course_module_created',
        'callback'    => '\quizaccess_exammonitor\observer::course_module_created',
        'includefile' => '/mod/quiz/accessrule/exammonitor/classes/observer.php',
    ],
    [
        'eventname'   => '\core\event\user_created',
        'callback'    => '\quizaccess_exammonitor\observer::user_created',
        'includefile' => '/mod/quiz/accessrule/exammonitor/classes/observer.php',
    ],
    [
        'eventname'   => '\core\event\role_assigned',
        'callback'    => '\quizaccess_exammonitor\observer::role_assigned',
        'includefile' => '/mod/quiz/accessrule/exammonitor/classes/observer.php',
    ],
];
