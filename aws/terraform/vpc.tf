data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "dlp_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "dlp-${var.environment}-vpc"
  }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.dlp_vpc.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "dlp-${var.environment}-public-${count.index}"
  }
}

resource "aws_subnet" "private_compute" {
  count             = 2
  vpc_id            = aws_vpc.dlp_vpc.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 2)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "dlp-${var.environment}-private-compute-${count.index}"
  }
}

resource "aws_subnet" "private_db" {
  count             = 2
  vpc_id            = aws_vpc.dlp_vpc.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 4)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "dlp-${var.environment}-private-db-${count.index}"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.dlp_vpc.id

  tags = {
    Name = "dlp-${var.environment}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.dlp_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "dlp-${var.environment}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# AWS PrivateLink VPC Endpoints ensuring zero public internet traversal for sensitive traffic
resource "aws_vpc_endpoint" "s3" {
  vpc_id       = aws_vpc.dlp_vpc.id
  service_name = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = [aws_route_table.public.id]
}

resource "aws_vpc_endpoint" "kms" {
  vpc_id              = aws_vpc.dlp_vpc.id
  service_name        = "com.amazonaws.${var.aws_region}.kms"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_compute[*].id
  private_dns_enabled = true
}

resource "aws_vpc_endpoint" "bedrock" {
  vpc_id              = aws_vpc.dlp_vpc.id
  service_name        = "com.amazonaws.${var.aws_region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_compute[*].id
  private_dns_enabled = true
}
