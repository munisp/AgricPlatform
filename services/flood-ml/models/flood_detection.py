"""
IBM Granite Geospatial Flood Detection Model
Wrapper for the granite-geospatial-uki-flooddetection model

Fail-closed: if the model weights cannot be loaded, construction raises
ModelLoadError. There is deliberately no mock/RNG fallback — a request that
cannot be served by the real model must surface as an error (HTTP 503),
never as fabricated inference.
"""
from __future__ import annotations

import numpy as np
from typing import Tuple, Dict, Optional


class ModelLoadError(RuntimeError):
    """Raised when the flood detection model weights cannot be loaded.

    The API layer maps this to HTTP 503 (service unavailable). It exists so
    a missing/failed model can never be mistaken for a loaded one.
    """


class FloodDetectionModel:
    """Wrapper for IBM Granite flood detection model"""

    def __init__(self,
                 model_name: str = "ibm-granite/granite-geospatial-uki-flooddetection",
                 device: Optional[str] = None):
        """
        Initialize flood detection model. Fails closed: raises ModelLoadError
        if the ML dependencies or the model weights cannot be loaded.

        Args:
            model_name: Hugging Face model identifier
            device: Device to run model on ('cuda' or 'cpu')
        """
        self.model_name = model_name
        self.weights_loaded = False

        # Imported lazily so this module (and the pure severity/alert helpers
        # below) stays importable in environments without the heavy ML stack.
        # Construction still fails closed when the stack is missing.
        try:
            import torch
            from transformers import (
                AutoModelForImageSegmentation,
                AutoImageProcessor,
            )
        except ImportError as e:
            raise ModelLoadError(
                "ML dependencies (torch/transformers) are not installed; "
                f"cannot load flood detection model: {e}"
            ) from e

        self._torch = torch
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')

        print(f"Loading flood detection model on {self.device}...")

        # Load model and processor. No fallback: any failure is fatal so the
        # caller can return 503 instead of fabricated predictions.
        try:
            self.model = AutoModelForImageSegmentation.from_pretrained(model_name)
            self.processor = AutoImageProcessor.from_pretrained(model_name)
        except Exception as e:
            raise ModelLoadError(
                f"Could not load flood detection model '{model_name}': {e}"
            ) from e

        self.model.eval()
        self.model.to(self.device)
        self.weights_loaded = True

        print("Flood detection model loaded successfully")
    
    def predict(self, input_tensor: torch.Tensor) -> Tuple[np.ndarray, np.ndarray]:
        """
        Predict flood areas from satellite imagery
        
        Args:
            input_tensor: Preprocessed input tensor (1, 9, 512, 512)
                         9 channels: B, G, R, NIR, SWIR1, SWIR2, VV, VH, Cloud Mask
        
        Returns:
            Tuple of (prediction_mask, probabilities)
            - prediction_mask: Binary mask (0 = no water, 1 = water/flood)
            - probabilities: Confidence probabilities for each class
        """
        if not self.weights_loaded or getattr(self, "model", None) is None:
            # Fail closed: never fabricate a prediction.
            raise ModelLoadError(
                "Flood detection model weights are not loaded; "
                "refusing to produce a prediction"
            )

        torch = self._torch
        with torch.no_grad():
            # Move input to device
            input_tensor = input_tensor.to(self.device)
            
            # Run inference
            outputs = self.model(input_tensor)
            
            # Get segmentation logits
            logits = outputs.logits
            
            # Apply softmax to get probabilities
            probs = torch.softmax(logits, dim=1)
            
            # Get predicted class (0 = no water, 1 = water)
            predictions = torch.argmax(probs, dim=1)
            
            # Move to CPU and convert to numpy
            prediction_mask = predictions.cpu().numpy()[0]
            probabilities = probs.cpu().numpy()[0]
            
            return prediction_mask, probabilities
    
    def calculate_flood_percentage(self, prediction_mask: np.ndarray) -> float:
        """
        Calculate percentage of area covered by flood/water
        
        Args:
            prediction_mask: Binary prediction mask
            
        Returns:
            Percentage of flooded area (0-100)
        """
        total_pixels = prediction_mask.size
        flooded_pixels = np.sum(prediction_mask == 1)
        return (flooded_pixels / total_pixels) * 100
    
    def calculate_flood_area_km2(self, 
                                prediction_mask: np.ndarray,
                                pixel_size_m: float = 10.0) -> float:
        """
        Calculate flood area in square kilometers
        
        Args:
            prediction_mask: Binary prediction mask
            pixel_size_m: Pixel size in meters (default: 10m for Sentinel-2)
            
        Returns:
            Flood area in km²
        """
        flooded_pixels = np.sum(prediction_mask == 1)
        pixel_area_m2 = pixel_size_m * pixel_size_m
        flood_area_m2 = flooded_pixels * pixel_area_m2
        flood_area_km2 = flood_area_m2 / 1_000_000
        return flood_area_km2
    
    def get_flood_statistics(self,
                           prediction_mask: np.ndarray,
                           probabilities: np.ndarray,
                           pixel_size_m: float = 10.0) -> Dict[str, float]:
        """
        Calculate comprehensive flood statistics
        
        Args:
            prediction_mask: Binary prediction mask
            probabilities: Probability map (2, H, W)
            pixel_size_m: Pixel size in meters
            
        Returns:
            Dictionary with flood statistics
        """
        # Get water probability (class 1)
        water_prob = probabilities[1]
        
        # Calculate statistics
        flood_percentage = self.calculate_flood_percentage(prediction_mask)
        flood_area_km2 = self.calculate_flood_area_km2(prediction_mask, pixel_size_m)
        
        # Average confidence for flooded areas
        flooded_mask = prediction_mask == 1
        if np.any(flooded_mask):
            avg_confidence = np.mean(water_prob[flooded_mask])
            max_confidence = np.max(water_prob[flooded_mask])
        else:
            avg_confidence = 0.0
            max_confidence = 0.0
        
        # Overall confidence
        overall_confidence = np.mean(np.max(probabilities, axis=0))
        
        return {
            'flood_detected': flood_percentage > 1.0,  # Threshold: 1%
            'flood_percentage': float(flood_percentage),
            'flood_area_km2': float(flood_area_km2),
            'avg_confidence': float(avg_confidence),
            'max_confidence': float(max_confidence),
            'overall_confidence': float(overall_confidence),
            'total_pixels': int(prediction_mask.size),
            'flooded_pixels': int(np.sum(flooded_mask))
        }
    
    @staticmethod
    def get_flood_severity(flood_percentage: float) -> str:
        """
        Classify flood severity based on percentage

        Args:
            flood_percentage: Percentage of flooded area

        Returns:
            Severity level: 'none', 'low', 'moderate', 'high', 'severe'
        """
        if flood_percentage < 1.0:
            return 'none'
        elif flood_percentage < 5.0:
            return 'low'
        elif flood_percentage < 15.0:
            return 'moderate'
        elif flood_percentage < 30.0:
            return 'high'
        else:
            return 'severe'
    
    @staticmethod
    def create_flood_alert(statistics: Dict[str, float],
                           location: Dict[str, float]) -> Dict:
        """
        Create flood alert message

        Args:
            statistics: Flood statistics from get_flood_statistics
            location: Location dict with 'latitude' and 'longitude'

        Returns:
            Alert dictionary
        """
        severity = FloodDetectionModel.get_flood_severity(statistics['flood_percentage'])

        alert = {
            'alert_type': 'flood_detection',
            'severity': severity,
            'location': location,
            'statistics': statistics,
            'message': FloodDetectionModel._generate_alert_message(severity, statistics),
            'recommended_actions': FloodDetectionModel._get_recommended_actions(severity)
        }

        return alert

    @staticmethod
    def _generate_alert_message(severity: str,
                                statistics: Dict[str, float]) -> str:
        """Generate human-readable alert message"""
        if severity == 'none':
            return "No significant flooding detected in the area."
        
        flood_pct = statistics['flood_percentage']
        flood_area = statistics['flood_area_km2']
        
        messages = {
            'low': f"Minor flooding detected. {flood_pct:.1f}% of area ({flood_area:.2f} km²) is affected.",
            'moderate': f"Moderate flooding detected. {flood_pct:.1f}% of area ({flood_area:.2f} km²) is affected.",
            'high': f"Significant flooding detected. {flood_pct:.1f}% of area ({flood_area:.2f} km²) is affected.",
            'severe': f"SEVERE flooding detected. {flood_pct:.1f}% of area ({flood_area:.2f} km²) is affected."
        }
        
        return messages.get(severity, "Unknown flood severity")
    
    @staticmethod
    def _get_recommended_actions(severity: str) -> list:
        """Get recommended actions based on severity"""
        actions = {
            'none': [
                "Continue normal operations",
                "Monitor weather forecasts"
            ],
            'low': [
                "Monitor the situation closely",
                "Check drainage systems",
                "Prepare for potential water accumulation"
            ],
            'moderate': [
                "Avoid affected areas if possible",
                "Secure equipment and livestock",
                "Prepare emergency drainage",
                "Contact local authorities if needed"
            ],
            'high': [
                "Evacuate livestock from affected areas",
                "Secure all valuable equipment",
                "Implement emergency drainage measures",
                "Contact emergency services",
                "Document damage for insurance"
            ],
            'severe': [
                "IMMEDIATE evacuation of affected areas",
                "Contact emergency services immediately",
                "Secure all personnel and livestock",
                "Activate emergency response plan",
                "Document all damage extensively"
            ]
        }
        
        return actions.get(severity, [])
