variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "prefix" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}
