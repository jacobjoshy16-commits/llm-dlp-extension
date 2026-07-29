resource "aws_iam_role" "eventbridge_ecs_role" {
  name = "dlp-${var.environment}-eventbridge-ecs-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "scheduler.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "eventbridge_ecs_policy" {
  name = "dlp-${var.environment}-eventbridge-ecs-policy"
  role = aws_iam_role.eventbridge_ecs_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RunTask"
        ]
        Resource = [
          "arn:aws:ecs:${var.aws_region}:*:task-definition/dlp-${var.environment}-*"
        ]
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.ecs_task_execution_role.arn,
          aws_iam_role.ecs_task_role.arn
        ]
      }
    ]
  })
}

# 17:45 America/Chicago EOD review task (Mon-Fri)
resource "aws_scheduler_schedule" "eod_review_schedule" {
  name       = "dlp-${var.environment}-eod-review-schedule"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(45 17 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Chicago"

  target {
    arn      = aws_ecs_cluster.dlp_cluster.arn
    role_arn = aws_iam_role.eventbridge_ecs_role.arn

    ecs_parameters {
      task_definition_arn = "arn:aws:ecs:${var.aws_region}:012345678901:task-definition/dlp-${var.environment}-eod-review:1"
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private_compute[*].id
        security_groups  = [aws_security_group.ecs_sg.id]
        assign_public_ip = false
      }
    }
  }
}

# 07:00 America/Chicago morning report task (Tue-Sat)
resource "aws_scheduler_schedule" "morning_report_schedule" {
  name       = "dlp-${var.environment}-morning-report-schedule"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(0 7 ? * TUE-SAT *)"
  schedule_expression_timezone = "America/Chicago"

  target {
    arn      = aws_ecs_cluster.dlp_cluster.arn
    role_arn = aws_iam_role.eventbridge_ecs_role.arn

    ecs_parameters {
      task_definition_arn = "arn:aws:ecs:${var.aws_region}:012345678901:task-definition/dlp-${var.environment}-morning-report:1"
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private_compute[*].id
        security_groups  = [aws_security_group.ecs_sg.id]
        assign_public_ip = false
      }
    }
  }
}

# 03:15 America/Chicago daily archive purge task
resource "aws_scheduler_schedule" "archive_purge_schedule" {
  name       = "dlp-${var.environment}-archive-purge-schedule"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(15 3 ? * * *)"
  schedule_expression_timezone = "America/Chicago"

  target {
    arn      = aws_ecs_cluster.dlp_cluster.arn
    role_arn = aws_iam_role.eventbridge_ecs_role.arn

    ecs_parameters {
      task_definition_arn = "arn:aws:ecs:${var.aws_region}:012345678901:task-definition/dlp-${var.environment}-archive-purge:1"
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private_compute[*].id
        security_groups  = [aws_security_group.ecs_sg.id]
        assign_public_ip = false
      }
    }
  }
}
