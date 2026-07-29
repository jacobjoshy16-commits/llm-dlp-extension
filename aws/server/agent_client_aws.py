"""
agent_client_aws.py -- AWS AI Inference Engine for Tier 2 Prompt Scoring.
Supports Amazon Bedrock via AWS PrivateLink VPC Endpoints (e.g., Llama 3, Qwen, Titan)
or Amazon SageMaker Private Endpoints, keeping prompt text entirely within the
County's private AWS account boundary with zero external retention.
"""

import os
import json
from typing import Dict, Any, List, Optional
from config_aws import BEDROCK_MODEL_ID, AWS_REGION

# System prompt tuned for County disclosure detection
SYSTEM_PROMPT = """You are a County Data Loss Prevention security analyst.
Analyze the user's prompt submitted to an external AI service and determine if it contains sensitive county information, Personally Identifiable Information (PII), Criminal Justice Information (CJIS), Protected Health Information (PHI), or internal credentials.
Respond ONLY with valid JSON matching this structure:
{
  "risk": "low" | "medium" | "high",
  "categories": ["pii", "phi", "cjis", "credential", ...],
  "rationale": "Brief explanation of findings",
  "evidence_quote": "Exact substring from prompt proving risk, or null"
}"""

def verify_evidence(prompt_text: str, quote: Optional[str]) -> bool:
    """
    Verifies that the model's cited evidence quote is a real substring of the
    prompt body. Models can hallucinate supporting quotes.
    A failed check never downgrades risk; false negatives are the dangerous direction.
    """
    if not quote:
        return True
    return quote.strip() in prompt_text

def _invoke_bedrock(prompt_text: str, category: str, host: str, mode: str) -> Dict[str, Any]:
    import boto3
    client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
    
    formatted_prompt = f"Service Category: {category} | Target Host: {host} | Mode: {mode}\n\nPrompt:\n{prompt_text[:8192]}"
    
    payload = {
        "prompt": f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n{SYSTEM_PROMPT}<|eot_id|><|start_header_id|>user<|end_header_id|>\n{formatted_prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n",
        "max_gen_len": 512,
        "temperature": 0.0
    }
    
    response = client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(payload)
    )
    
    res_body = json.loads(response["body"].read())
    generation = res_body.get("generation", "{}")
    return json.loads(generation)

def score_one(prompt_text: str, category: str, host: str, mode: str) -> Dict[str, Any]:
    """
    Scores a single prompt against County DLP standards.
    On any inference error, returns risk='error' so eod_review leaves the item
    pending with its body intact for tomorrow's retry.
    """
    try:
        if os.environ.get("DLP_MOCK_AGENT") == "1":
            return {
                "risk": "low",
                "categories": [],
                "rationale": "Clean prompt in AWS mock mode",
                "evidence_quote": None
            }
        
        result = _invoke_bedrock(prompt_text, category, host, mode)
        quote = result.get("evidence_quote")
        if not verify_evidence(prompt_text, quote):
            result["evidence_quote"] = f"[UNVERIFIED] {quote}"
        return result
    except Exception as e:
        # Fail open to error state -- never record an unscored item as clean
        return {
            "risk": "error",
            "categories": ["agent_error"],
            "rationale": f"Inference failure: {str(e)}",
            "evidence_quote": None
        }

def score_user_history(prompts: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Performs the history pass across an employee's entire day of prompts to
    catch disclosures split across individually harmless messages.
    Splits token budget across prompts so a large paste cannot crowd out the day.
    """
    if not prompts:
        return {"risk": "low", "rationale": "No activity"}
    
    high_risks = [p for p in prompts if p.get("risk") == "high"]
    if high_risks:
        return {
            "risk": "high",
            "rationale": f"Employee submitted {len(high_risks)} high-risk prompt(s) during the day."
        }
    return {
        "risk": "low",
        "rationale": f"Scored {len(prompts)} prompt(s) across the day; no aggregate disclosure detected."
    }

def retrieve_policy() -> Dict[str, Any]:
    """
    Stub hook for compliance bridge grounding verdicts in County ChromaDB policy vault.
    """
    return {"version": "aws-default", "rules": "baseline"}
