resource "aws_db_subnet_group" "dlp_db_subnet_group" {
  name       = "dlp-${var.environment}-db-subnet-group"
  subnet_ids = aws_subnet.private_db[*].id

  tags = {
    Name = "DLP DB Subnet Group"
  }
}

resource "aws_security_group" "db_sg" {
  name        = "dlp-${var.environment}-db-sg"
  description = "Security group for Aurora PostgreSQL Serverless v2"
  vpc_id      = aws_vpc.dlp_vpc.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "dlp-${var.environment}-db-sg"
  }
}

resource "aws_rds_cluster" "dlp_aurora" {
  cluster_identifier      = "dlp-${var.environment}-aurora-cluster"
  engine                  = "aurora-postgresql"
  engine_mode             = "provisioned"
  engine_version          = "15.4"
  database_name           = "dlpdb"
  master_username         = "dlpadmin"
  manage_master_user_password = true
  db_subnet_group_name    = aws_db_subnet_group.dlp_db_subnet_group.name
  vpc_security_group_ids  = [aws_security_group.db_sg.id]
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.dlp_cmk.arn

  serverlessv2_scaling_configuration {
    max_capacity = 4.0
    min_capacity = 0.5
  }

  tags = {
    Name = "dlp-${var.environment}-aurora"
  }
}

resource "aws_rds_cluster_instance" "dlp_aurora_instances" {
  count              = 2
  identifier         = "dlp-${var.environment}-aurora-instance-${count.index}"
  cluster_identifier = aws_rds_cluster.dlp_aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.dlp_aurora.engine
  engine_version     = aws_rds_cluster.dlp_aurora.engine_version
}
