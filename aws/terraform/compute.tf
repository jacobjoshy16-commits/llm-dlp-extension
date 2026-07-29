resource "aws_ecs_cluster" "dlp_cluster" {
  name = "dlp-${var.environment}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "dlp_logs" {
  name              = "/ecs/dlp-${var.environment}"
  retention_in_days = 90
}

resource "aws_ecs_task_definition" "receiver" {
  family                   = "dlp-${var.environment}-receiver"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  container_definitions = jsonencode([
    {
      name      = "receiver"
      image     = "dlp-backend:latest"
      command   = ["python3", "-m", "uvicorn", "receiver_aws:app", "--host", "0.0.0.0", "--port", "8787"]
      essential = true
      portMappings = [
        {
          containerPort = 8787
          hostPort      = 8787
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "DLP_ENV", value = var.environment },
        { name = "DLP_DB_HOST", value = aws_rds_cluster.dlp_aurora.endpoint },
        { name = "DLP_DB_NAME", value = "dlpdb" },
        { name = "DLP_DB_USER", value = "dlpadmin" },
        { name = "DLP_ARCHIVE", value = tostring(var.dlp_archive_enabled) },
        { name = "DLP_ARCHIVE_RETENTION_DAYS", value = tostring(var.dlp_archive_retention_days) }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.dlp_logs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "receiver"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "receiver" {
  name            = "dlp-${var.environment}-receiver-service"
  cluster         = aws_ecs_cluster.dlp_cluster.id
  task_definition = aws_ecs_task_definition.receiver.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private_compute[*].id
    security_groups  = [aws_security_group.ecs_sg.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.receiver_tg.arn
    container_name   = "receiver"
    container_port   = 8787
  }

  depends_on = [aws_lb_target_group.receiver_tg]
}
