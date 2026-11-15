terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

module "network" {
  source = "./modules/network"
  cidr   = var.vpc_cidr
}

module "storage" {
  source      = "./modules/storage"
  bucket_name = "${var.prefix}-uploads"
  vpc_id      = module.network.vpc_id
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "api" {
  function_name = "${var.prefix}-api"
  role          = aws_iam_role.lambda.arn
  handler       = "app.handler"
  runtime       = "python3.12"
  filename      = "build/api.zip"

  environment {
    variables = {
      BUCKET = module.storage.bucket_name
    }
  }

  vpc_config {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [aws_security_group.api.id]
  }

  depends_on = [aws_iam_role_policy_attachment.lambda_logs]
}

resource "aws_security_group" "api" {
  name   = "${var.prefix}-api"
  vpc_id = module.network.vpc_id
}
